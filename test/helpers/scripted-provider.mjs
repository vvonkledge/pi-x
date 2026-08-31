// A scripted openai-completions transport. Every real-Pi test runs against this
// instead of a model, so the suite is offline and deterministic.
//
// Each test gets its own instance on its own port. A single instance shared by
// concurrent agents would hand turn 1 to whichever child connected first.

import { createServer } from "node:http";

export async function startScriptedProvider(t, { turns, status = 200 } = {}) {
  const seen = [];
  let call = 0;

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      seen.push({
        url: request.url,
        authorization: request.headers.authorization ?? null,
        body: JSON.parse(body || "{}"),
      });
      if (status !== 200) {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "scripted upstream failure" }));
        return;
      }
      const chunks = turns[Math.min(call, turns.length - 1)] ?? [];
      call += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const port = server.address().port;
  return {
    port,
    seen,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    // The provider block a spec carries for a scripted or local model. It never
    // holds apiKey or headers; pix writes the credential reference itself.
    providerConfig() {
      return {
        baseUrl: this.baseUrl,
        api: "openai-completions",
        authHeader: true,
        compat: { supportsUsageInStreaming: false, supportsDeveloperRole: false },
        models: [
          { id: "scripted-1", name: "Scripted 1", contextWindow: 100_000, maxTokens: 4096 },
        ],
      };
    },
  };
}

export function textTurn(text) {
  return [
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

export function toolCallTurn(name, args) {
  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}
