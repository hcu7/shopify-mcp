import crypto from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ServerFactory, TransportInstance } from "./types.js";

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
