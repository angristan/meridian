import { type RequestUrlParam, requestUrl } from "obsidian"
import type { HttpResponse, HttpTransport } from "./transport"

export class ObsidianHttpTransport implements HttpTransport {
  async request(request: RequestUrlParam): Promise<HttpResponse> {
    const response = await requestUrl({ ...request, throw: false })
    return {
      status: response.status,
      headers: response.headers,
      body: response.arrayBuffer,
      text: response.text,
    }
  }
}
