export function isSecureMode(): boolean {
    return !!process.env.OPENCODE_SERVER_PASSWORD
}

export function getAuthorizationHeader(): string | undefined {
    const password = process.env.OPENCODE_SERVER_PASSWORD
    if (!password) return undefined

    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
    // Use Buffer for Node.js base64 encoding (btoa may not be available in all Node versions)
    const credentials = Buffer.from(`${username}:${password}`).toString("base64")
    return `Basic ${credentials}`
}

export function configureClientAuth(client: any): any {
    const authHeader = getAuthorizationHeader()

    if (!authHeader) {
        return client
    }

    // Secure-mode contract: depends on the OpenCode SDK exposing either
    // `client._client` or `client.client` with an `interceptors.request`
    // axios-style API. Both names have been observed in the SDK at different
    // versions. Failure mode is silent — verify by header inspection on
    // startup or with `curl -H 'Authorization: Basic ...' http://server/health`.
    // ponytail: `??` over `||` — nullish coalescing is the precise intent
    // (don't fall through on `0`/`""`/falsy); a future SDK change that
    // leaves a sentinel value should still probe the alternate. BUG-070.
    const innerClient = client._client ?? client.client

    if (innerClient?.interceptors?.request) {
        innerClient.interceptors.request.use((request: Request) => {
            // Only add auth header if not already present
            if (!request.headers.has("Authorization")) {
                request.headers.set("Authorization", authHeader)
            }
            return request
        })
    } else {
        // ponytail: best-effort — secure mode without the expected SDK shape
        // means unauthenticated requests; one debug line is cheaper than
        // silently broken auth.
        if (process.env.DCP_DEBUG) {
            console.debug("[dcp] configureClientAuth: no interceptable client found")
        }
    }

    return client
}
