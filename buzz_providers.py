"""The one small adapter between Buzz and the model providers (Claude and Gemini).

Buzz keeps its conversation in a provider-neutral shape and each provider turns it into its own request:

    {"role": "user", "text": "...", "note": "optional note from the app"}
    {"role": "assistant", "text": "...", "calls": [{"id", "name", "args"}], "raw": <what the provider sent, replayed as is>}
    {"role": "tool", "results": [{"id", "name", "output": {...}}]}

Every provider has one method, generate(system, messages, tools, max_tokens), and returns a Turn. A provider that is busy,
rate-limited, down, or that answers with nothing usable raises ProviderError; Buzz then shows its friendly fallback and
offers to create a ticket. The error text is only ever an error type or an HTTP status number, never a response body, a
header or a key, so nothing secret can reach a log or the browser.
"""

import json
import urllib.error
import urllib.request


class ProviderError(Exception):
    """The provider could not answer (busy, rate-limited, down, bad key). Carries only a short type or status."""


class Turn:
    """One model answer: text, and/or tool calls it wants run."""

    def __init__(self, text="", calls=(), raw=None, input_tokens=0, output_tokens=0, refused=False):
        self.text, self.calls, self.raw = text, list(calls), raw
        self.input_tokens, self.output_tokens, self.refused = input_tokens, output_tokens, refused


class Provider:
    name = "base"
    price_input = 0.0           # US dollars per million tokens, used for the daily cost cap
    price_output = 0.0

    def generate(self, system, messages, tools, max_tokens):
        raise NotImplementedError


# ---- Claude ----------------------------------------------------------------------------------------------

class AnthropicProvider(Provider):
    name = "anthropic"
    price_input, price_output = 0.10, 0.50          # Claude Haiku 5.5

    def __init__(self, model, client=None, api_key=""):
        self.model, self._client, self._key = model, client, api_key

    def client(self):
        if self._client is None:
            import anthropic
            self._client = anthropic.Anthropic(api_key=self._key, max_retries=1, timeout=25.0)
        return self._client

    @staticmethod
    def _messages(messages):
        out = []
        for message in messages:
            if message["role"] == "user":
                if message.get("note"):
                    content = [{"type": "text", "text": message["text"]},
                               {"type": "text", "text": "[from the PrintBee app, not typed by the customer] " + message["note"]}]
                else:
                    content = message["text"]
                out.append({"role": "user", "content": content})
            elif message["role"] == "assistant":
                out.append({"role": "assistant", "content": message["raw"] if message.get("raw") is not None else message["text"]})
            else:
                out.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": result["id"], "content": json.dumps(result["output"])}
                                                        for result in message["results"]]})
        return out

    def generate(self, system, messages, tools, max_tokens):
        try:
            response = self.client().messages.create(model=self.model, max_tokens=max_tokens, system=system, tools=tools,
                                                     messages=self._messages(messages), output_config={"effort": "low"})
        except Exception as error:      # rate limit, outage, bad key, SDK missing: the caller only needs to know it failed
            raise ProviderError(type(error).__name__) from None
        usage = response.usage
        turn = Turn(raw=response.content, input_tokens=getattr(usage, "input_tokens", 0), output_tokens=getattr(usage, "output_tokens", 0))
        if response.stop_reason == "refusal":
            turn.refused = True
            return turn
        turn.text = " ".join(block.text for block in response.content if block.type == "text").strip()
        if response.stop_reason == "tool_use":
            turn.calls = [{"id": block.id, "name": block.name, "args": block.input} for block in response.content if block.type == "tool_use"]
        return turn


# ---- Gemini (plain HTTPS, no extra package) ---------------------------------------------------------------

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
GEMINI_BLOCKED = ("SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION")


def http_post(url, headers, body, timeout=25):
    """POST JSON, return the parsed answer. Any failure becomes ProviderError with a status number or error type only."""
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise ProviderError(f"http {error.code}") from None
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise ProviderError(type(error).__name__) from None


def _gemini_schema(node):
    """Our tool schemas are written for Claude. Gemini takes the same shape minus a few keys."""
    if isinstance(node, dict):
        return {key: _gemini_schema(value) for key, value in node.items() if key not in ("additionalProperties", "strict")
                and not (key == "required" and value == [])}
    if isinstance(node, list):
        return [_gemini_schema(item) for item in node]
    return node


class GeminiProvider(Provider):
    name = "gemini"
    price_input, price_output = 0.30, 2.50          # a cautious default; set the real prices in the environment

    def __init__(self, model, api_key, post=None, price_input=None, price_output=None):
        self.model, self._key, self._post = model, api_key, post or http_post
        if price_input is not None:
            self.price_input = price_input
        if price_output is not None:
            self.price_output = price_output

    @staticmethod
    def declarations(tools):
        declared = []
        for tool in tools:
            schema = _gemini_schema(tool["input_schema"])
            item = {"name": tool["name"], "description": tool["description"]}
            if schema.get("properties"):
                item["parameters"] = schema          # a tool with no arguments must have no "parameters" at all
            declared.append(item)
        return declared

    @staticmethod
    def _contents(messages):
        out = []
        for message in messages:
            if message["role"] == "user":
                parts = [{"text": message["text"]}]
                if message.get("note"):
                    parts.append({"text": "[from the PrintBee app, not typed by the customer] " + message["note"]})
                out.append({"role": "user", "parts": parts})
            elif message["role"] == "assistant":
                if message.get("raw") is not None:
                    parts = message["raw"]           # replayed exactly as received (keeps any thought signatures)
                else:
                    parts = [{"text": message["text"]}] if message["text"] else []
                    parts += [{"functionCall": {"name": call["name"], "args": call["args"]}} for call in message.get("calls", [])]
                out.append({"role": "model", "parts": parts})
            else:
                out.append({"role": "user", "parts": [{"functionResponse": {"name": result["name"], "response": {"result": result["output"]}}}
                                                      for result in message["results"]]})
        return out

    def body(self, system, messages, tools, max_tokens):
        return {"systemInstruction": {"parts": [{"text": system}]}, "contents": self._contents(messages),
                "tools": [{"functionDeclarations": self.declarations(tools)}],
                "generationConfig": {"maxOutputTokens": max_tokens * 2}}      # thinking models spend part of this on thinking

    def generate(self, system, messages, tools, max_tokens):
        url = GEMINI_URL.format(model=self.model)
        data = self._post(url, {"Content-Type": "application/json", "x-goog-api-key": self._key},
                          self.body(system, messages, tools, max_tokens))
        usage = data.get("usageMetadata") or {}
        turn = Turn(input_tokens=usage.get("promptTokenCount", 0),
                    output_tokens=usage.get("candidatesTokenCount", 0) + usage.get("thoughtsTokenCount", 0))
        if (data.get("promptFeedback") or {}).get("blockReason"):
            turn.refused = True
            return turn
        candidates = data.get("candidates") or []
        if not candidates:
            raise ProviderError("empty answer")
        parts = (candidates[0].get("content") or {}).get("parts") or []
        texts = []
        for index, part in enumerate(parts):
            if "functionCall" in part:
                call = part["functionCall"]
                turn.calls.append({"id": f"call_{index}", "name": call.get("name", ""), "args": call.get("args") or {}})
            elif part.get("text") and not part.get("thought"):
                texts.append(part["text"])
        turn.text, turn.raw = " ".join(texts).strip(), parts
        turn.refused = not turn.text and not turn.calls and candidates[0].get("finishReason") in GEMINI_BLOCKED
        return turn
