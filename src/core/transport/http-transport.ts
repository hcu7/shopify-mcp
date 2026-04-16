import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ServerFactory, TransportInstance } from "./types.js";

// Path where the Shopify install-flow persists the merchant-granted
// Admin API access token. Client-credentials auth falls back to reading
// this file so that scope upgrades from the install flow take effect
// without needing a static_token redeploy.
const INSTALLED_TOKEN_FILE = process.env.SHOPIFY_INSTALLED_TOKEN_FILE
	|| "/app/data/installed-token.json";

// Verify Shopify's HMAC on install / callback query strings.
// All query params except `hmac` are concatenated as `k=v&k=v&...` (sorted),
// then HMAC-SHA256'd with the app's client secret.
function verifyShopifyHmac(queryString: string, secret: string): boolean {
	const params = new URLSearchParams(queryString);
	const hmac = params.get("hmac");
	if (!hmac) return false;
	params.delete("hmac");
	params.delete("signature");
	const sortedKeys = Array.from(params.keys()).sort();
	const canonical = sortedKeys.map((k) => `${k}=${params.get(k)}`).join("&");
	const expected = crypto
		.createHmac("sha256", secret)
		.update(canonical)
		.digest("hex");
	try {
		return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(hmac, "hex"));
	} catch {
		return false;
	}
}

function persistInstalledToken(shop: string, accessToken: string, scope: string): void {
	const payload = { shop, access_token: accessToken, scope, installedAt: new Date().toISOString() };
	const dir = path.dirname(INSTALLED_TOKEN_FILE);
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {}
	fs.writeFileSync(INSTALLED_TOKEN_FILE, JSON.stringify(payload, null, 2));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
		req.on("error", reject);
	});
}

// OAuth2 state (when OAUTH_CLIENT_ID is set)
interface CodeEntry { expiry: number; challenge: string; method: string; }
const oauthCodes = new Map<string, CodeEntry>();
const oauthTokens = new Set<string>();

function verifyPKCE(verifier: string, challenge: string, method: string): boolean {
	if (!challenge) return true;
	if (method === "S256") {
		const computed = crypto.createHash("sha256").update(verifier).digest("base64url");
		return computed === challenge;
	}
	if (method === "" || method === "plain") return verifier === challenge;
	return false;
}

function auditLog(event: Record<string, unknown>): void {
	const record = { ts: new Date().toISOString().replace(/\.\d+Z$/, "Z"), svc: "shopify-mcp", ...event };
	process.stdout.write(`[MCP-AUDIT] ${JSON.stringify(record)}\n`);
}

function getClientIp(req: IncomingMessage): string {
	const xff = req.headers["x-forwarded-for"];
	if (typeof xff === "string") return xff.split(",")[0].trim();
	return req.socket.remoteAddress || "";
}

function checkAuth(req: IncomingMessage): { ok: boolean; method: string; token: string } {
	const token = process.env.MCP_AUTH_TOKEN;
	const oauthClient = process.env.OAUTH_CLIENT_ID;
	const auth = req.headers["authorization"];
	const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
	if (!token && !oauthClient) return { ok: true, method: "none-configured", token: bearer };
	if (token && bearer === token) return { ok: true, method: "bearer", token: bearer };
	if (oauthTokens.has(bearer)) return { ok: true, method: "oauth", token: bearer };
	return { ok: false, method: "none", token: bearer };
}

function send401WithWWWAuthenticate(req: IncomingMessage, res: ServerResponse): void {
	const host = req.headers.host || "";
	const metaUrl = host ? `https://${host}/.well-known/oauth-protected-resource` : "";
	const wwwAuth = `Bearer realm="mcp", resource_metadata="${metaUrl}"`;
	res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": wwwAuth });
	res.end(JSON.stringify({ error: "Unauthorized" }));
}

export class HttpTransport implements TransportInstance {
	private httpServer: Server | null = null;
	/** Per-session transports. Key is the `mcp-session-id` header. */
	private sessions = new Map<string, StreamableHTTPServerTransport>();
	/** Legacy single-transport mode (only used if caller passed a fully-built McpServer). */
	private sharedTransport: StreamableHTTPServerTransport | null = null;
	private serverFactory: ServerFactory | null = null;

	constructor(
		private port: number = 3000,
		private host: string = "0.0.0.0",
	) {}

	get address(): AddressInfo | null {
		if (!this.httpServer) return null;
		const addr = this.httpServer.address();
		if (typeof addr === "string" || addr === null) return null;
		return addr;
	}

	/**
	 * Create a new session: fresh McpServer from factory, fresh transport, connect them.
	 * Each session is stored in `this.sessions` keyed by its session-id so subsequent
	 * requests with the same `mcp-session-id` header reuse the correct transport.
	 * This works around modelcontextprotocol/typescript-sdk#1405 where a single
	 * McpServer can only hold one transport at a time.
	 */
	private async createSession(): Promise<StreamableHTTPServerTransport> {
		if (!this.serverFactory) throw new Error("No server factory configured");
		const server = await this.serverFactory();
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
		});
		transport.onclose = () => {
			const sid = transport.sessionId;
			if (sid) this.sessions.delete(sid);
		};
		await server.connect(transport);
		return transport;
	}

	async start(serverOrFactory: McpServer | ServerFactory): Promise<void> {
		if (typeof serverOrFactory === "function") {
			this.serverFactory = serverOrFactory as ServerFactory;
		} else {
			// Legacy shared-transport mode (does not support concurrent clients).
			this.sharedTransport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => crypto.randomUUID(),
			});
			await serverOrFactory.connect(this.sharedTransport);
		}

		this.httpServer = createServer(async (req, res) => {
			// Health check
			if (req.method === "GET" && req.url === "/health") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ status: "ok" }));
				return;
			}

			// -----------------------------------------------------------------
			// Shopify install flow
			//   Shopify Partners "App URL"      → /shopify/install
			//   Shopify Partners "Redirect URL" → /shopify/callback
			// The install handler redirects to Shopify's /admin/oauth/authorize;
			// the callback handler exchanges the returned code for an Admin API
			// access token and persists it. client-credentials.ts then prefers
			// this token so scope changes from the install flow take effect.
			// -----------------------------------------------------------------
			const shopifyClientId = process.env.SHOPIFY_CLIENT_ID || "";
			const shopifyClientSecret = process.env.SHOPIFY_CLIENT_SECRET || "";
			const shopifyScopes = process.env.SHOPIFY_SCOPES || [
				"read_products", "write_products",
				"read_orders", "write_orders", "read_all_orders",
				"read_draft_orders", "write_draft_orders",
				"read_customers", "write_customers",
				"read_inventory", "write_inventory",
				"read_locations",
				"read_publications", "write_publications",
				"read_files", "write_files",
				"read_metaobjects", "write_metaobjects",
				"read_metaobject_definitions", "write_metaobject_definitions",
				"read_fulfillments", "write_fulfillments",
				"read_assigned_fulfillment_orders", "write_assigned_fulfillment_orders",
				"read_merchant_managed_fulfillment_orders", "write_merchant_managed_fulfillment_orders",
				"read_third_party_fulfillment_orders", "write_third_party_fulfillment_orders",
				"read_shipping",
				"read_reports",
				"read_legal_policies",
				"read_discounts", "write_discounts",
				"read_content", "write_content",
				"read_translations", "write_translations",
				"read_marketing_events", "write_marketing_events",
				"read_gift_cards", "write_gift_cards",
				"read_price_rules", "write_price_rules",
				"read_themes", "write_themes",
				"read_online_store_pages", "write_online_store_pages",
				"read_online_store_navigation", "write_online_store_navigation",
				"read_script_tags", "write_script_tags",
			].join(",");

			// GET /shopify/install?shop=foo.myshopify.com → redirect to Shopify authorize
			if (req.method === "GET" && req.url?.startsWith("/shopify/install")) {
				const url = new URL(req.url, `http://localhost:${this.port}`);
				const shop = url.searchParams.get("shop") || "";
				const clientIp = getClientIp(req);
				if (!shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
					auditLog({ event: "shopify_install", ip: clientIp, result: "invalid_shop", shop });
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Missing or invalid shop parameter" }));
					return;
				}
				if (!shopifyClientId) {
					auditLog({ event: "shopify_install", ip: clientIp, result: "misconfigured" });
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "SHOPIFY_CLIENT_ID not configured" }));
					return;
				}
				// Shopify signs the install-entry request too — validate when present.
				const qs = (req.url.split("?")[1] || "");
				if (qs.includes("hmac=") && !verifyShopifyHmac(qs, shopifyClientSecret)) {
					auditLog({ event: "shopify_install", ip: clientIp, result: "hmac_mismatch", shop });
					res.writeHead(401, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "HMAC validation failed" }));
					return;
				}
				const host = req.headers.host || "";
				const redirectUri = `https://${host}/shopify/callback`;
				const state = crypto.randomUUID();
				const authorizeUrl = `https://${shop}/admin/oauth/authorize`
					+ `?client_id=${encodeURIComponent(shopifyClientId)}`
					+ `&scope=${encodeURIComponent(shopifyScopes)}`
					+ `&redirect_uri=${encodeURIComponent(redirectUri)}`
					+ `&state=${encodeURIComponent(state)}`;
				auditLog({ event: "shopify_install", ip: clientIp, result: "redirect_to_authorize",
					shop, redirect_uri: redirectUri });
				res.writeHead(302, { Location: authorizeUrl });
				res.end();
				return;
			}

			// GET /shopify/callback?code=...&shop=...&hmac=... → exchange + persist
			if (req.method === "GET" && req.url?.startsWith("/shopify/callback")) {
				const clientIp = getClientIp(req);
				const qs = req.url.split("?")[1] || "";
				const url = new URL(req.url, `http://localhost:${this.port}`);
				const shop = url.searchParams.get("shop") || "";
				const code = url.searchParams.get("code") || "";
				if (!shop || !code) {
					auditLog({ event: "shopify_callback", ip: clientIp, result: "missing_params", shop });
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Missing shop or code" }));
					return;
				}
				if (!verifyShopifyHmac(qs, shopifyClientSecret)) {
					auditLog({ event: "shopify_callback", ip: clientIp, result: "hmac_mismatch", shop });
					res.writeHead(401, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "HMAC validation failed" }));
					return;
				}
				try {
					const tokenUrl = `https://${shop}/admin/oauth/access_token`;
					const tokenRes = await fetch(tokenUrl, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							client_id: shopifyClientId,
							client_secret: shopifyClientSecret,
							code,
						}),
					});
					if (!tokenRes.ok) {
						const body = await tokenRes.text();
						auditLog({ event: "shopify_callback", ip: clientIp, result: "token_exchange_failed",
							shop, status: tokenRes.status });
						res.writeHead(502, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Token exchange failed", detail: body }));
						return;
					}
					const data = await tokenRes.json() as { access_token: string; scope?: string };
					persistInstalledToken(shop, data.access_token, data.scope || "");
					auditLog({ event: "shopify_callback", ip: clientIp, result: "installed",
						shop, scope_len: (data.scope || "").length });
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Shopify MCP — Install complete</title>
<style>body{font-family:system-ui;max-width:640px;margin:4rem auto;padding:0 1rem;color:#111}
h1{color:#0a7c42}code{background:#f4f4f5;padding:2px 6px;border-radius:4px}</style></head>
<body><h1>✓ Installation erfolgreich</h1>
<p>Access Token für <code>${shop}</code> wurde gespeichert. Scopes: <code>${data.scope || "(none)"}</code>.</p>
<p>Der MCP zieht den neuen Token automatisch beim nächsten Tool-Call. Container-Restart nicht nötig.</p>
<p>Du kannst dieses Fenster schließen.</p></body></html>`);
					return;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					auditLog({ event: "shopify_callback", ip: clientIp, result: "exception", shop, err: msg });
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Internal error during install" }));
					return;
				}
			}

			const oauthClient = process.env.OAUTH_CLIENT_ID;
			const oauthSecret = process.env.OAUTH_CLIENT_SECRET || "";

			// OAuth 2.0 discovery + DCR
			if (oauthClient) {
				const host = req.headers.host || "";
				const base = host ? `https://${host}` : "";
				if (req.url === "/.well-known/oauth-authorization-server") {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						issuer: base,
						authorization_endpoint: `${base}/authorize`,
						token_endpoint: `${base}/token`,
						registration_endpoint: `${base}/register`,
						response_types_supported: ["code"],
						grant_types_supported: ["authorization_code"],
						token_endpoint_auth_methods_supported: ["client_secret_post"],
						code_challenge_methods_supported: ["S256", "plain"],
						scopes_supported: ["mcp"],
					}));
					return;
				}
				if (req.url === "/.well-known/oauth-protected-resource") {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						resource: base,
						authorization_servers: [base],
						bearer_methods_supported: ["header"],
						scopes_supported: ["mcp"],
					}));
					return;
				}
				if (req.url === "/register" && req.method === "POST") {
					auditLog({ event: "oauth_register", ip: getClientIp(req) });
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						client_id: oauthClient,
						client_secret: oauthSecret,
						token_endpoint_auth_method: "client_secret_post",
						grant_types: ["authorization_code"],
						response_types: ["code"],
					}));
					return;
				}
			}

			// OAuth2 /authorize
			if (oauthClient && req.method === "GET" && req.url?.startsWith("/authorize")) {
				const url = new URL(req.url, `http://localhost:${this.port}`);
				const clientId = url.searchParams.get("client_id") || "";
				const redirectUri = url.searchParams.get("redirect_uri") || "";
				const state = url.searchParams.get("state") || "";
				const challenge = url.searchParams.get("code_challenge") || "";
				const challengeMethod = url.searchParams.get("code_challenge_method") || (challenge ? "plain" : "");
				if (clientId !== oauthClient || !redirectUri) {
					auditLog({ event: "oauth_authorize", ip: getClientIp(req), result: "invalid_client" });
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "invalid_client" }));
					return;
				}
				const code = crypto.randomUUID();
				oauthCodes.set(code, { expiry: Date.now() + 60_000, challenge, method: challengeMethod });
				const host = req.headers.host || "";
				const issuer = host ? `https://${host}` : "";
				const location = `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(issuer)}`;
				auditLog({ event: "oauth_authorize", ip: getClientIp(req), result: "code_issued",
					pkce: !!challenge, redirect_uri: redirectUri, has_state: !!state });
				res.writeHead(302, { Location: location });
				res.end();
				return;
			}

			// OAuth2 /token
			if (oauthClient && req.method === "POST" && req.url === "/token") {
				const raw = await readBody(req);
				const params = new URLSearchParams(raw);
				const clientId = params.get("client_id") || "";
				const clientSecret = params.get("client_secret") || "";
				const code = params.get("code") || "";
				const codeVerifier = params.get("code_verifier") || "";

				if (clientId !== oauthClient) {
					auditLog({ event: "oauth_token", ip: getClientIp(req), result: "invalid_client_id" });
					res.writeHead(401, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "invalid_client" }));
					return;
				}
				if (!clientSecret || clientSecret !== oauthSecret) {
					auditLog({ event: "oauth_token", ip: getClientIp(req), result: "missing_or_invalid_secret" });
					res.writeHead(401, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "invalid_client" }));
					return;
				}
				if (params.get("grant_type") === "authorization_code" && code) {
					const entry = oauthCodes.get(code);
					oauthCodes.delete(code);
					if (!entry || Date.now() > entry.expiry) {
						auditLog({ event: "oauth_token", ip: getClientIp(req), result: "invalid_grant" });
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "invalid_grant" }));
						return;
					}
					if (entry.challenge && !verifyPKCE(codeVerifier, entry.challenge, entry.method)) {
						auditLog({ event: "oauth_token", ip: getClientIp(req), result: "pkce_mismatch" });
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "invalid_grant" }));
						return;
					}
				}
				const accessToken = crypto.randomUUID();
				oauthTokens.add(accessToken);
				auditLog({ event: "oauth_token", ip: getClientIp(req), result: "token_issued", pkce: !!codeVerifier });
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ access_token: accessToken, token_type: "Bearer" }));
				return;
			}

			// Auth check for all MCP requests
			const clientIp = getClientIp(req);
			const authResult = checkAuth(req);
			if (!authResult.ok) {
				const rawAuth = (req.headers["authorization"] as string) || "";
				const reason = !rawAuth ? "no_auth_header" :
					!rawAuth.startsWith("Bearer ") ? "not_bearer_scheme" :
					!authResult.token ? "empty_token" : "unknown_token";
				auditLog({ event: "mcp_request", ip: clientIp, method: req.method, result: "401_unauthorized",
					reason, token_len: authResult.token.length, tokens_issued: oauthTokens.size });
				send401WithWWWAuthenticate(req, res);
				return;
			}

			// Session-aware request dispatch (per-session transport)
			try {
				if (this.serverFactory) {
					const sessionId = req.headers["mcp-session-id"] as string | undefined;
					let transport: StreamableHTTPServerTransport;

					if (sessionId && this.sessions.has(sessionId)) {
						transport = this.sessions.get(sessionId)!;
					} else if (req.method === "POST" && !sessionId) {
						transport = await this.createSession();
					} else if (sessionId) {
						res.writeHead(404, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Session not found" }));
						return;
					} else {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Missing session ID" }));
						return;
					}

					if (req.method === "POST") {
						const rawBody = await readBody(req);
						let body: unknown;
						try {
							body = JSON.parse(rawBody);
						} catch {
							res.writeHead(400, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
							return;
						}
						if (body && typeof body === "object") {
							const rpc = body as Record<string, unknown>;
							const params = (rpc.params || {}) as Record<string, unknown>;
							const info: Record<string, unknown> = {
								event: "mcp_call", ip: clientIp, auth: authResult.method,
								size: rawBody.length, rpc_method: rpc.method,
							};
							if (rpc.method === "tools/call") {
								info.tool = params.name;
								const args = (params.arguments || {}) as Record<string, unknown>;
								info.arg_keys = args && typeof args === "object" ? Object.keys(args).sort() : [];
							} else if (rpc.method === "initialize") {
								info.client = ((params.clientInfo || {}) as Record<string, unknown>).name || "?";
							}
							auditLog(info);
						}
						await transport.handleRequest(req, res, body);
					} else {
						await transport.handleRequest(req, res);
					}

					if (transport.sessionId && !this.sessions.has(transport.sessionId)) {
						this.sessions.set(transport.sessionId, transport);
					}
				} else if (this.sharedTransport) {
					// Legacy shared-transport path (does not support multi-client concurrency)
					if (req.method === "DELETE" || req.method === "GET") {
						await this.sharedTransport.handleRequest(req, res);
						return;
					}
					const rawBody = await readBody(req);
					let body: unknown;
					try {
						body = JSON.parse(rawBody);
					} catch {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
						return;
					}
					if (body && typeof body === "object") {
						const rpc = body as Record<string, unknown>;
						auditLog({ event: "mcp_call", ip: clientIp, auth: authResult.method,
							size: rawBody.length, rpc_method: rpc.method });
					}
					await this.sharedTransport.handleRequest(req, res, body);
				}
			} catch (err) {
				process.stderr.write(`MCP transport error: ${err instanceof Error ? err.stack : String(err)}\n`);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
				}
			}
		});

		await new Promise<void>((resolve, reject) => {
			this.httpServer?.on("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE") {
					reject(new Error(`Port ${this.port} is already in use. Choose a different port with --port.`));
				} else {
					reject(err);
				}
			});
			this.httpServer?.listen(this.port, this.host, () => {
				const addr = this.httpServer?.address() as AddressInfo;
				process.stderr.write(`MCP server started on http://${addr.address}:${addr.port}\n`);
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		if (this.httpServer) {
			await new Promise<void>((resolve) => {
				this.httpServer?.close(() => resolve());
			});
		}
		for (const t of this.sessions.values()) {
			await t.close();
		}
		this.sessions.clear();
		if (this.sharedTransport) {
			await this.sharedTransport.close();
		}
	}
}
