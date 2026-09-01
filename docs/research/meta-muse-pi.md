# Meta Muse Spark API with pi

## Verified facts

- The [Meta API reference](https://dev.meta.ai/docs/api-reference/) defines the base URL as `https://api.meta.ai/v1`, uses bearer authentication with `$MODEL_API_KEY`, and documents OpenAI-compatible Responses and Chat Completions APIs.
- The [Meta models documentation](https://dev.meta.ai/docs/models/) lists `muse-spark-1.2-contributor` with text, image, video, and PDF input, text output, a 1,048,576-token context window, and tool calling.
- The models documentation says that Contributor prompts and completions may be used to train future Meta models.
- The [Meta quickstart](https://dev.meta.ai/docs/quickstart/) sets the output limit to 131,072 tokens and recommends Responses for coding agents because it supports encrypted reasoning replay.
- The [Meta coding-agent guide](https://dev.meta.ai/docs/coding-agents/) recommends Responses and gives the Meta base URL, `$MODEL_API_KEY`, context window, output limit, reasoning support, and modalities.
- The [Meta reasoning documentation](https://dev.meta.ai/docs/reasoning/) supports `minimal`, `low`, `medium`, `high`, and `xhigh`, and rejects `none`.
- The [Meta tool-calling documentation](https://dev.meta.ai/docs/tool-calling/) says tool calls work with Responses and Chat Completions, and only `tool_choice: "auto"` is supported.
- The [Meta pricing documentation](https://dev.meta.ai/docs/pricing-rate-limits/) lists Contributor rates of $0.10 input, $0.20 output, and $0.002 cached input per million tokens, and warns that training is allowed.

## pi configuration

- The installed [pi model documentation](/Users/dmitridmitriev/.nvm/versions/node/v24.10.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md) supports custom `openai-responses` models in `~/.pi/agent/models.json`.
- The installed pi-ai `dist/api/openai-responses.js` sends `store: false`, reasoning effort and summary, and `include: ["reasoning.encrypted_content"]` when reasoning is enabled, so the standard pi adapter meets Meta's stateless replay recommendation.
- The pi model entry declares text and image input because pi supports text and image attachments, so PDF and video are not declared even though Meta supports them.
- The model-level thinking map marks `off` and `max` unsupported and maps `minimal`, `low`, `medium`, `high`, and `xhigh` to the same provider values because Muse Spark cannot turn reasoning off.
