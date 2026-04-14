import crypto from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { TransportInstance } from "./types.js";

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
		req.on("error", reject);
	});
}

// OAuth2 state (when OAUTH_CLIENT_ID is set)
const oauthCodes = new Map<string, number>();
const oauthTokens = new Set<string>();

function auditLog(event: Record<string, unknown>): void {
	const record = { ts: new Date().toISOString().replace(/\.\d+Z$/, "Z"), svc: "shopify-mcp", ...event };
	process.stdout.write(`[MCP-AUDIT] ${JSON.stringify(record)}\n`);
}

function getClientIp(req: IncomingMessage): string {
	const xff = req.headers["x-forwarded-for"];
	if (typeof xff === "string") return xff.split(",")[0].trim();
	return req.socket.remoteAddress || "";
}

function checkAuth(req: IncomingMessage): { ok: boolean; method: string } {
	const token = process.env.MCP_AUTH_TOKEN;
	const oauthClient = process.env.OAUTH_CLIENT_ID;
	if (!token && !oauthClient) return { ok: true, method: "none-configured" };
	const auth = req.headers["authorization"];
	const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
	if (token && bearer === token) return { ok: true, method: "bearer" };
	if (oauthTokens.has(bearer)) return { ok: true, method: "oauth" };
	return { ok: false, method: "none" };
}

export class HttpTransport implements TransportInstance {
	private httpServer: Server | null = null;
	private transport: StreamableHTTPServerTransport | null = null;

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

	async start(server: McpServer): Promise<void> {
		this.transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
		});

		this.httpServer = createServer(async (req, res) => {
			// Health check endpoint
			if (req.method === "GET" && req.url === "/health") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ status: "ok" }));
				return;
			}

			// OAuth2 Authorization endpoint
			const oauthClient = process.env.OAUTH_CLIENT_ID;
			const oauthSecret = process.env.OAUTH_CLIENT_SECRET || "";
			if (oauthClient && req.method === "GET" && req.url?.startsWith("/authorize")) {
				const url = new URL(req.url, `http://localhost:${this.port}`);
				if (url.searchParams.get("client_id") !== oauthClient || !url.searchParams.get("redirect_uri")) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "invalid_client" }));
					return;
				}
				const code = crypto.randomUUID();
				oauthCodes.set(code, Date.now() + 60_000);
				const location = `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state") || "")}`;
				res.writeHead(302, { Location: location });
				res.end();
				return;
			}
			// OAuth2 Token endpoint
			if (oauthClient && req.method === "POST" && req.url === "/token") {
				const raw = await readBody(req);
				const params = new URLSearchParams(raw);
				if (params.get("client_id") !== oauthClient || params.get("client_secret") !== oauthSecret) {
					res.writeHead(401, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "invalid_client" }));
					return;
				}
				const code = params.get("code") || "";
				if (params.get("grant_type") === "authorization_code" && code) {
					const exp = oauthCodes.get(code);
					oauthCodes.delete(code);
					if (!exp || Date.now() > exp) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "invalid_grant" }));
						return;
					}
				}
				const accessToken = crypto.randomUUID();
				oauthTokens.add(accessToken);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ access_token: accessToken, token_type: "Bearer" }));
				return;
			}

			// Auth check for all MCP requests
			const clientIp = getClientIp(req);
			const authResult = checkAuth(req);
			if (!authResult.ok) {
				auditLog({ event: "mcp_request", ip: clientIp, method: req.method, result: "401_unauthorized" });
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Unauthorized" }));
				return;
			}

			// Handle DELETE for session termination
			if (req.method === "DELETE") {
				await this.transport?.handleRequest(req, res);
				return;
			}

			// Handle GET for SSE stream (server-sent events)
			if (req.method === "GET") {
				await this.transport?.handleRequest(req, res);
				return;
			}

			// POST — read and parse body, then pass to transport
			try {
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
				await this.transport?.handleRequest(req, res, body);
			} catch (err) {
				process.stderr.write(`MCP transport error: ${err instanceof Error ? err.stack : String(err)}\n`);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
				}
			}
		});

		await server.connect(this.transport);

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
		if (this.transport) {
			await this.transport.close();
		}
	}
}
