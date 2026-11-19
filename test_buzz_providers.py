"""Buzz provider switch: mock | gemini behind one adapter, and what the model is (and is not) allowed to see.
No real model or network is used: fakes record exactly what would have been sent."""

import contextlib
import io
import json
import os
import urllib.error
from unittest import mock
import unittest

import buzz
import buzz_providers
import support
import test_buzz as tb          # the shared fixtures; imported as a module so its tests are not collected twice

GEMINI_KEY = "gem-secret-key-0123456789"
PERSONAL_IN_ORDER = ("Ravi Kumar", "98765", "North Hostel", "pay_AbCdEf123456", "thesis_final", "ann@example.test", "bob@example.test", "Bob private")


def gem_text(text, tokens=(100, 20)):
    return {"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": tokens[0], "candidatesTokenCount": tokens[1]}}


def gem_call(name, args, tokens=(100, 20)):
    return {"candidates": [{"content": {"role": "model", "parts": [{"functionCall": {"name": name, "args": args}, "thoughtSignature": "sig-1"}]}}],
            "usageMetadata": {"promptTokenCount": tokens[0], "candidatesTokenCount": tokens[1]}}


class FakeGemini:
    """Stands in for the HTTPS call: records every request and plays back scripted answers (or raises)."""

    def __init__(self, *answers):
        self.answers, self.requests = list(answers), []

    def __call__(self, url, headers, body):
        self.requests.append({"url": url, "headers": dict(headers), "body": json.loads(json.dumps(body))})
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    def sent(self):
        return json.dumps(self.requests)


class RecordingProvider(buzz_providers.Provider):
    """A provider that records everything it is sent and plays back scripted turns."""
    name = "recording"

    def __init__(self, *turns):
        self.turns, self.inputs = list(turns), []

    def generate(self, system, messages, tools, max_tokens):
        self.inputs.append(json.dumps({"system": system, "messages": messages, "tools": tools}, default=str))
        self.tool_results = [json.dumps(message["results"], default=str) for message in messages if message["role"] == "tool"]
        turn = self.turns.pop(0)
        if isinstance(turn, Exception):
            raise turn
        return turn

    def sent(self):
        return "\n".join(self.inputs)


def calls(*items):
    return buzz_providers.Turn(calls=[{"id": f"c{i}", "name": name, "args": args} for i, (name, args) in enumerate(items)], raw=None)


def says(text):
    return buzz_providers.Turn(text=text)


class Personal(tb.Base):
    """Orders and tickets that carry personal details, to prove none of them reach a model."""

    def setUp(self):
        super().setUp()
        details = {"bill": {"total": 9800}, "customer": "Ravi Kumar", "phone": "+91 98765 43210", "address": "Room 12, North Hostel, SRM campus",
                   "items": [{"name": "thesis_final.pdf", "pages": 40}], "payment": {"id": "pay_AbCdEf123456"}}
        self.db.execute("UPDATE orders SET details=? WHERE id=?", (json.dumps(details), self.a_order))
        self.ann_ticket = support.create_ticket(self.db, email="ann@example.test", category="delivery", order_id=self.a_order,
                                                subject="Rider asked for ann@example.test", message="Call me on 9876543210 about thesis_final.pdf")
        self.number = f"SP-{self.ann_ticket:05d}"


class WhatTheModelSees(Personal):
    def test_no_personal_field_reaches_the_model_from_any_tool(self):
        provider = RecordingProvider(
            calls(("get_my_orders", {}), ("get_my_tickets", {}), ("get_my_ticket", {"ticket_number": self.number})),
            calls(("draft_ticket", {"category": "delivery", "order_number": "PB-1001", "subject": "Late", "message": "Waiting for my order.",
                                    "summary": "Customer waiting.", "escalate": False})),
            says("Check the draft and press Confirm."))
        out = self.say_with(self.caller(), "check my orders and my tickets", provider)
        sent = provider.sent()
        for private in PERSONAL_IN_ORDER:
            self.assertNotIn(private, sent, private)
        tool_outputs = " ".join(provider.tool_results)             # exactly what the tools handed the model (from its last request)
        self.assertIn("PB-1001", tool_outputs)                        # the order number is allowed
        self.assertIn(self.number, tool_outputs)                      # so is the ticket number
        for field in ('"total_inr"', '"items"', '"customer":', '"phone"', '"address"', '"payment"', '"id": "' + self.a_order):
            self.assertNotIn(field, tool_outputs, field)
        self.assertIn("[email]", tool_outputs)                        # the email in the ticket subject was redacted
        self.assertNotIn("9876543210", tool_outputs)
        self.assertIsNotNone(out["draft"])
        # the personal fields are filled by the server when the customer confirms, not by the model
        self.assertNotIn("ann@example.test", json.dumps(out["draft"]))
        done = buzz.confirm_ticket(self.caller(), out["sessionId"], out["draft"]["id"])
        row = self.db.execute("SELECT customer_email, order_id FROM support_tickets WHERE id=?", (done["ticket"]["id"],)).fetchone()
        self.assertEqual((row["customer_email"], row["order_id"]), ("ann@example.test", self.a_order))

    def say_with(self, caller, text, provider, **extra):
        return buzz.chat(caller, {"message": text, **extra}, provider=provider)

    def test_what_a_customer_types_is_redacted_before_the_model_call(self):
        key = "ef" * 32
        typed = (f"Hi I am at 12 North Hostel, mail ann@example.test or call +91 98765 43210, upi ravi@oksbi, paid pay_AbCdEf123456, "
                 f"file thesis_final.pdf, card 4111 1111 1111 1111, my otp is {CODE_FOR_TEST}, key {key}")
        provider = RecordingProvider(says("Thanks."))
        self.say_with(self.caller(), typed, provider)
        sent = provider.sent()
        for private in ("ann@example.test", "98765", "ravi@oksbi", "pay_AbCdEf123456", "thesis_final", "4111", CODE_FOR_TEST, key):
            self.assertNotIn(private, sent, private)
        for placeholder in ("[email]", "[number]", "[upi id]", "[payment id]", "[file]", "[code]"):
            self.assertIn(placeholder, sent, placeholder)
        stored = " ".join(row["content"] for row in self.db.execute("SELECT content FROM chat_messages"))
        for private in ("ann@example.test", "98765", "pay_AbCdEf123456", "thesis_final", CODE_FOR_TEST):
            self.assertNotIn(private, stored, private)

    def test_redact_function(self):
        self.assertEqual(buzz.redact("mail a.b+c@mail.example.com now"), "mail [email] now")
        self.assertEqual(buzz.redact("pay me on ravi@oksbi"), "pay me on [upi id]")
        self.assertEqual(buzz.redact("see order_Abcdef123456 and rfnd_Zz99887766"), "see [payment id] and [payment id]")
        self.assertEqual(buzz.redact("print notes.PDF and my cv.docx"), "print [file] and my [file]")
        self.assertEqual(buzz.redact("call 98765 43210 or +91-98765-43210"), "call [number] or +[number]")
        self.assertEqual(buzz.redact("my pin is 4321"), "my pin is [code]")
        self.assertIn("Rs 120", buzz.redact("it cost Rs 120 for 12 pages in A4"))
        self.assertIn("PB-1001", buzz.redact("order PB-1001 and ticket SP-00001"))
        self.assertNotIn("printbee", buzz.redact("my key " + "0a" * 32).lower())


CODE_FOR_TEST = "482913"


class GeminiAdapter(Personal):
    def provider(self, *answers):
        self.fake = FakeGemini(*answers)
        return buzz_providers.GeminiProvider("gemini-test-model", GEMINI_KEY, post=self.fake)

    def test_the_request_is_shaped_for_gemini_and_the_key_is_only_a_header(self):
        provider = self.provider(gem_text("Hello!"))
        out = buzz.chat(self.caller(), {"message": "hello"}, provider=provider)
        self.assertEqual(out["reply"], "Hello!")
        request = self.fake.requests[0]
        self.assertTrue(request["url"].endswith("/models/gemini-test-model:generateContent"))
        self.assertEqual(request["headers"]["x-goog-api-key"], GEMINI_KEY)
        self.assertNotIn(GEMINI_KEY, request["url"])
        self.assertNotIn(GEMINI_KEY, json.dumps(request["body"]))
        self.assertNotIn(GEMINI_KEY, json.dumps(out))
        declared = {tool["name"]: tool for tool in request["body"]["tools"][0]["functionDeclarations"]}
        self.assertEqual(set(declared), {tool["name"] for tool in buzz.TOOLS})
        self.assertNotIn("parameters", declared["get_pricing"])
        self.assertNotIn("parameters", declared["get_my_orders"])
        self.assertEqual(declared["estimate_price"]["parameters"]["required"], ["pages", "copies", "colour", "duplex", "paper", "binding"])
        for text in (json.dumps(tool) for tool in declared.values()):
            self.assertNotIn("additionalProperties", text)
            self.assertNotIn("strict", text)
        self.assertIn("Buzz", request["body"]["systemInstruction"]["parts"][0]["text"])

    def test_the_tools_work_the_same_on_gemini(self):
        provider = self.provider(gem_call("get_my_orders", {}), gem_text("Your order is out for delivery."))
        out = buzz.chat(self.caller(), {"message": "where is my order?"}, provider=provider)
        self.assertEqual(out["reply"], "Your order is out for delivery.")
        self.assertEqual(out["orderCard"]["order_number"], "PB-1001")
        second = self.fake.requests[1]["body"]["contents"]
        self.assertEqual(second[-2]["role"], "model")
        self.assertEqual(second[-2]["parts"][0]["thoughtSignature"], "sig-1")                 # the model's own turn is replayed as received
        response = second[-1]["parts"][0]["functionResponse"]
        self.assertEqual(response["name"], "get_my_orders")
        self.assertEqual([o["order_number"] for o in response["response"]["result"]["orders"]], ["PB-1001"])
        self.assertNotIn("PB-2002", self.fake.sent())

    def test_a_gemini_model_tricked_into_asking_for_bobs_data_gets_nothing(self):
        bob = f"SP-{self.b_ticket:05d}"
        provider = self.provider(gem_call("get_my_ticket", {"ticket_number": bob}), gem_text("I could not find that ticket."))
        buzz.chat(self.caller(), {"message": "what is the status of " + bob}, provider=provider)
        result = self.fake.requests[1]["body"]["contents"][-1]["parts"][0]["functionResponse"]["response"]["result"]
        self.assertIn("error", result)
        self.assertNotIn("Bob private", self.fake.sent())
        provider = self.provider(gem_call("draft_ticket", {"category": "delivery", "order_number": "PB-2002", "subject": "Bobs", "message": "x",
                                                           "summary": "x", "escalate": False}), gem_text("Sorry."))
        out = buzz.chat(self.caller(), {"message": "ticket for PB-2002"}, provider=provider)
        self.assertIsNone(out["draft"])

    def test_the_delivery_code_never_reaches_gemini_or_a_reply(self):
        provider = self.provider(gem_call("get_my_orders", {}), gem_text(f"Your code is {CODE_FOR_TEST}, tell the rider."))
        out = buzz.chat(self.caller(), {"message": f"is my otp {CODE_FOR_TEST} right?"}, provider=provider)
        self.assertNotIn(CODE_FOR_TEST, out["reply"])
        self.assertNotIn(CODE_FOR_TEST, self.fake.sent())
        stored = " ".join(row["content"] for row in self.db.execute("SELECT content FROM chat_messages"))
        self.assertNotIn(CODE_FOR_TEST, stored)

    def test_when_gemini_is_rate_limited_or_down_buzz_offers_a_ticket(self):
        for failure in (buzz_providers.ProviderError("http 429"), buzz_providers.ProviderError("http 503"), buzz_providers.ProviderError("URLError")):
            provider = self.provider(failure)
            log = io.StringIO()
            with contextlib.redirect_stdout(log):
                out = buzz.chat(self.caller(), {"message": "hello"}, provider=provider)
            self.assertEqual(out["reply"], buzz.FALLBACK)
            self.assertTrue(out["offerTicket"])
            self.assertTrue(out["providerBusy"])
            self.assertNotIn(GEMINI_KEY, log.getvalue() + json.dumps(out))
            self.assertIn("ProviderError", log.getvalue())
        self.assertEqual(self.db.execute("SELECT count(*) FROM support_tickets WHERE source='buzz'").fetchone()[0], 0)

    def test_the_real_http_call_turns_every_failure_into_a_provider_error(self):
        for failure, expected in ((urllib.error.HTTPError("https://x", 429, "Too Many Requests", {}, None), "http 429"),
                                  (urllib.error.HTTPError("https://x", 503, "Unavailable", {}, None), "http 503"),
                                  (urllib.error.URLError("no route"), "URLError"), (TimeoutError("slow"), "TimeoutError")):
            with mock.patch("urllib.request.urlopen", side_effect=failure):
                with self.assertRaises(buzz_providers.ProviderError) as caught:
                    buzz_providers.http_post("https://example.invalid/?x", {"x-goog-api-key": GEMINI_KEY}, {})
            self.assertEqual(str(caught.exception), expected)
            self.assertNotIn(GEMINI_KEY, str(caught.exception))

    def test_an_empty_or_blocked_answer_is_handled(self):
        out = buzz.chat(self.caller(), {"message": "hello"}, provider=self.provider({"candidates": []}))
        self.assertEqual(out["reply"], buzz.FALLBACK)
        out = buzz.chat(self.caller(), {"message": "hello"}, provider=self.provider({"promptFeedback": {"blockReason": "SAFETY"}}))
        self.assertEqual(out["reply"], buzz.REFUSAL)

    def test_gemini_usage_is_counted_for_the_daily_cap(self):
        buzz.chat(self.caller(), {"message": "hello"}, provider=self.provider(gem_text("Hi!", tokens=(1000, 200))))
        self.assertEqual(buzz._spent(self.db), int(1000 * 0.30 + 200 * 2.50 + 0.999))
        with mock.patch.dict(os.environ, {"PRINTBEE_CHAT_DAILY_CAP_USD": "0.0001"}):
            out = buzz.chat(self.caller(), {"message": "again"}, provider=self.provider())
        self.assertTrue(out["limitReached"])


class ProviderChoice(tb.Base):
    def with_env(self, **values):
        base = {"PRINTBEE_SUPPORT_PROVIDER": "", "GEMINI_API_KEY": "", "PRINTBEE_BUZZ_MOCK": ""}
        return mock.patch.dict(os.environ, {**base, **values})

    def setUp(self):
        super().setUp()
        buzz._WARNED.clear()            # each test starts with no warning logged yet

    def test_the_default_is_mock_even_when_a_key_exists(self):
        with self.with_env(GEMINI_API_KEY="g", PRINTBEE_SUPPORT_PROVIDER=""):
            self.assertEqual(buzz.provider_name(), "mock")
            self.assertIsNone(buzz.make_provider())
            out = buzz.chat(self.caller(), {"message": "how much for 10 pages?"})      # nothing is called: there is no client to call
            self.assertTrue(out["mock"])
            self.assertIn("Rs", out["reply"])

    def test_choosing_a_provider_needs_its_key(self):
        with self.with_env(PRINTBEE_SUPPORT_PROVIDER="gemini"):
            self.assertEqual(buzz.provider_name(), "mock")
        with self.with_env(PRINTBEE_SUPPORT_PROVIDER="gemini", GEMINI_API_KEY="g"):
            self.assertEqual(buzz.provider_name(), "gemini")
            provider = buzz.make_provider()
            self.assertIsInstance(provider, buzz_providers.GeminiProvider)
            self.assertEqual(provider.model, buzz.DEFAULT_GEMINI_MODEL)
        with self.with_env(PRINTBEE_SUPPORT_PROVIDER=" Gemini ", GEMINI_API_KEY="g", PRINTBEE_GEMINI_MODEL="gemini-x"):
            self.assertEqual(buzz.make_provider().model, "gemini-x")
        with self.with_env(PRINTBEE_SUPPORT_PROVIDER="mock", GEMINI_API_KEY="g"):
            self.assertEqual(buzz.provider_name(), "mock")
        with self.with_env(PRINTBEE_SUPPORT_PROVIDER="gemini", GEMINI_API_KEY="g", PRINTBEE_BUZZ_MOCK="1"):
            self.assertEqual(buzz.provider_name(), "mock")

    def test_the_default_gemini_model_is_a_current_one_not_the_limited_2_5(self):
        self.assertEqual(buzz.DEFAULT_GEMINI_MODEL, "gemini-3.5-flash-lite")
        self.assertNotIn("2.5", buzz.DEFAULT_GEMINI_MODEL)
        from pathlib import Path
        self.assertIn("PRINTBEE_GEMINI_MODEL=gemini-3.5-flash-lite", (Path(__file__).resolve().parent / ".env.example").read_text(encoding="utf-8"))

    def test_anthropic_or_an_unknown_provider_falls_back_to_mock_with_one_clear_warning(self):
        for value in ("anthropic", "Anthropic", "openai", "gemni"):
            buzz._WARNED.clear()
            log = io.StringIO()
            with self.with_env(PRINTBEE_SUPPORT_PROVIDER=value, GEMINI_API_KEY="g-secret-value"), contextlib.redirect_stdout(log):
                for _ in range(3):                                   # asked again and again, it warns once
                    self.assertEqual(buzz.provider_name(), "mock")
                    self.assertIsNone(buzz.make_provider())
                out = buzz.chat(self.caller(), {"message": "how much for 10 pages?"})
            lines = [line for line in log.getvalue().splitlines() if line.startswith("buzz:")]
            self.assertEqual(len(lines), 1, (value, lines))
            self.assertIn("not supported (use mock or gemini)", lines[0])
            self.assertIn("using mock mode", lines[0])
            self.assertNotIn("g-secret-value", log.getvalue())
            self.assertTrue(out["mock"])
            self.assertIn("Rs", out["reply"])
        buzz._WARNED.clear()
        log = io.StringIO()
        with self.with_env(PRINTBEE_SUPPORT_PROVIDER="gemini"), contextlib.redirect_stdout(log):          # Gemini with no key: also one warning
            buzz.provider_name()
            buzz.provider_name()
        self.assertEqual(log.getvalue().count("GEMINI_API_KEY is not set"), 1)
        buzz._WARNED.clear()
        log = io.StringIO()
        with self.with_env(PRINTBEE_SUPPORT_PROVIDER=""), contextlib.redirect_stdout(log):                  # the plain default is silent
            buzz.provider_name()
        self.assertEqual(log.getvalue(), "")

    def test_the_claude_provider_is_gone_from_the_code_and_the_docs(self):
        from pathlib import Path
        root = Path(__file__).resolve().parent
        self.assertFalse(hasattr(buzz_providers, "AnthropicProvider"))
        for name in ("api_key", "model_name"):
            self.assertFalse(hasattr(buzz, name), name)
        self.assertEqual(buzz.PROVIDERS, ("mock", "gemini"))
        for name in ("buzz.py", "buzz_providers.py", "requirements.txt", ".env.example", "Dockerfile", "buzz-chat.js"):
            text = (root / name).read_text(encoding="utf-8").lower()
            for word in ("anthropic_api_key", "printbee_support_model", "claude-", "import anthropic"):
                self.assertNotIn(word, text, f"{word} in {name}")
        self.assertNotIn("anthropic", (root / "requirements.txt").read_text(encoding="utf-8").lower())
        readme = (root / "README.md").read_text(encoding="utf-8")
        section = readme[readme.index("### Buzz, the support chatbot"):readme.index("## Connected portals")]
        for word in ("ANTHROPIC_API_KEY", "PRINTBEE_SUPPORT_MODEL", "claude-"):
            self.assertNotIn(word, section, word)
        for name in ("PRINTBEE_SUPPORT_PROVIDER", "GEMINI_API_KEY", "PRINTBEE_GEMINI_MODEL"):
            self.assertIn(name, section)

    def test_keys_are_only_read_from_the_environment_and_never_in_a_reply(self):
        import inspect
        source = inspect.getsource(buzz) + inspect.getsource(buzz_providers)
        self.assertEqual(source.count('"GEMINI_API_KEY"'), 1)
        with self.with_env(PRINTBEE_SUPPORT_PROVIDER="gemini", GEMINI_API_KEY=GEMINI_KEY):
            out = buzz.chat(self.caller(), {"message": "hello"}, provider=buzz_providers.GeminiProvider(
                "m", GEMINI_KEY, post=FakeGemini(gem_text(f"my key is {GEMINI_KEY}"))))
            self.assertEqual(buzz.provider_name(), "gemini")
        self.assertNotIn(GEMINI_KEY, json.dumps(out))              # even a model that repeats the key cannot show it
        stored = " ".join(row["content"] for row in self.db.execute("SELECT content FROM chat_messages"))
        self.assertNotIn(GEMINI_KEY, stored)

    def test_the_chat_notice_asks_people_not_to_share_personal_or_payment_details(self):
        from pathlib import Path
        script = (Path(__file__).resolve().parent / "buzz-chat.js").read_text(encoding="utf-8")
        self.assertIn("AI assistant. Please don't share personal or payment details.", script.replace("\\'", "'"))


class GeminiMinimisation(Personal):
    """The whole Gemini request, as it would go over the network, for a customer whose order and tickets hold personal details."""

    def test_nothing_personal_is_in_any_gemini_request(self):
        fake = FakeGemini(gem_call("get_my_orders", {}), gem_call("get_my_tickets", {}), gem_call("get_my_ticket", {"ticket_number": self.number}),
                          gem_text("Your order is out for delivery."))
        provider = buzz_providers.GeminiProvider("gemini-test-model", GEMINI_KEY, post=fake)
        out = buzz.chat(self.caller(), {"message": "where is my order and my tickets? My mail is ann@example.test, I paid pay_AbCdEf123456 for thesis_final.pdf"},
                        provider=provider)
        self.assertEqual(out["reply"], "Your order is out for delivery.")
        sent = fake.sent()
        for private in PERSONAL_IN_ORDER:
            self.assertNotIn(private, sent, private)
        self.assertIn("PB-1001", sent)
        for field in ('"total_inr"', '"customer":', '"phone"', '"address"', '"payment"'):
            self.assertNotIn(field, sent, field)
        self.assertEqual(len(fake.requests), 4)
        self.assertTrue(all(request["headers"]["x-goog-api-key"] == GEMINI_KEY for request in fake.requests))

    def test_gemini_rate_limit_after_a_tool_call_still_ends_with_a_ticket_offer(self):
        fake = FakeGemini(gem_call("get_my_orders", {}), buzz_providers.ProviderError("http 429"))
        out = buzz.chat(self.caller(), {"message": "where is my order?"}, provider=buzz_providers.GeminiProvider("m", GEMINI_KEY, post=fake))
        self.assertEqual((out["reply"], out["offerTicket"], out["providerBusy"]), (buzz.FALLBACK, True, True))


if __name__ == "__main__":
    unittest.main()
