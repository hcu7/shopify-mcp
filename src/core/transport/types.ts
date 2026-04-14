import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type TransportType = "stdio" | "http";

export interface TransportConfig {
	type: TransportType;
	httpPort?: number; // default 3000
	httpHost?: string; // default '0.0.0.0'
}

/** Factory that produces a fresh McpServer per session (for HTTP multi-client). */
export type ServerFactory = () => Promise<McpServer>;

export interface TransportInstance {
	/**
	 * For stdio: pass the single McpServer instance.
	 * For HTTP: pass a ServerFactory so multiple concurrent clients each get
	 * their own server+transport (workaround for MCP SDK's 1-transport limit).
	 * Passing an McpServer to HttpTransport still works but serializes clients.
	 */
	start(serverOrFactory: McpServer | ServerFactory): Promise<void>;
	stop(): Promise<void>;
}
