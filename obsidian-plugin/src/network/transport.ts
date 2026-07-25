import type { RequestUrlParam } from "obsidian"

export interface HttpResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: ArrayBuffer
  readonly text: string
}

export interface HttpTransport {
  request(request: RequestUrlParam): Promise<HttpResponse>
}
