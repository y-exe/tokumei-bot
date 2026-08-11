import json
import os
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import core.logic as logic
from core.logic import (
    AnonymousPostRateLimited,
    _claim_anonymous_send_slot,
    check_ban,
    get_content_policy_violation,
    is_valid_discord_webhook_url,
    parse_datetime_utc,
    revoke_anonymous_request_access,
)
from utils.json import load_json, save_json


class ContentPolicyTests(unittest.TestCase):
    @staticmethod
    def _configured_filters(path, default):
        if str(path).endswith("keywords.json"):
            return ["禁止語"]
        if str(path).endswith("domains.json"):
            return ["example.com"]
        return default

    def test_zero_width_keyword_is_blocked(self):
        with patch("core.logic.load_json", side_effect=self._configured_filters):
            self.assertIn("禁止語", get_content_policy_violation("禁\u200b止語"))

    def test_full_width_domain_is_blocked(self):
        with patch("core.logic.load_json", side_effect=self._configured_filters):
            violation = get_content_policy_violation("ｈｔｔｐｓ：／／ｅｘａｍｐｌｅ．ｃｏｍ")
            self.assertIn("example.com", violation)

    def test_zero_width_mention_is_blocked(self):
        with patch("core.logic.load_json", side_effect=self._configured_filters):
            self.assertIsNotNone(get_content_policy_violation("@every\u200bone"))


class WebhookValidationTests(unittest.TestCase):
    def setUp(self):
        token = "a" * 68
        self.valid_url = f"https://discord.com/api/webhooks/12345678901234567/{token}"

    def test_discord_webhook_is_accepted(self):
        self.assertTrue(is_valid_discord_webhook_url(self.valid_url))

    def test_non_discord_webhook_is_rejected(self):
        self.assertFalse(is_valid_discord_webhook_url(self.valid_url.replace("discord.com", "evil.example")))

    def test_insecure_webhook_is_rejected(self):
        self.assertFalse(is_valid_discord_webhook_url(self.valid_url.replace("https://", "http://")))


class AnonymousPostRateLimitTests(unittest.TestCase):
    def setUp(self):
        logic._anonymous_send_timestamps.clear()

    def tearDown(self):
        logic._anonymous_send_timestamps.clear()

    def test_same_user_and_channel_is_rate_limited(self):
        with patch.object(logic, "ANONYMOUS_POST_COOLDOWN_SECONDS", 5):
            _claim_anonymous_send_slot("channel-1", "user-1", now=10)
            with self.assertRaises(AnonymousPostRateLimited) as caught:
                _claim_anonymous_send_slot("channel-1", "user-1", now=11)

        self.assertEqual(caught.exception.retry_after_seconds, 4)

    def test_different_user_or_channel_has_an_independent_limit(self):
        with patch.object(logic, "ANONYMOUS_POST_COOLDOWN_SECONDS", 5):
            _claim_anonymous_send_slot("channel-1", "user-1", now=10)
            _claim_anonymous_send_slot("channel-1", "user-2", now=11)
            _claim_anonymous_send_slot("channel-2", "user-1", now=11)
            _claim_anonymous_send_slot("channel-1", "user-1", now=15)


class AnonymousRequestBanTests(unittest.IsolatedAsyncioTestCase):
    def test_revoke_is_persisted_to_database_with_audit_metadata(self):
        with (
            patch("core.logic.db.is_enabled", return_value=True),
            patch("core.logic.db.ban_anonymous_request_user") as persist,
        ):
            revoke_anonymous_request_access(
                "20",
                banned_by="30",
                guild_id="40",
                report_message_id="50",
                original_message_id="60",
            )

        persist.assert_called_once_with(
            "20",
            banned_by="30",
            guild_id="40",
            report_message_id="50",
            original_message_id="60",
        )

    async def test_normal_anonymous_channel_does_not_check_ban_database(self):
        interaction = SimpleNamespace(
            channel=SimpleNamespace(id=10),
            user=SimpleNamespace(id=20),
        )

        with patch("core.logic.db.is_enabled") as is_enabled:
            self.assertFalse(await check_ban(interaction, {"10": {"channel_type": "normal"}}))

        is_enabled.assert_not_called()

    async def test_banned_user_is_blocked_in_anonymous_request_channel(self):
        sent_messages = []

        class Response:
            @staticmethod
            def is_done():
                return False

            async def send_message(self, **kwargs):
                sent_messages.append(kwargs)

        interaction = SimpleNamespace(
            channel=SimpleNamespace(id=10),
            user=SimpleNamespace(id=20),
            response=Response(),
        )

        with (
            patch("core.logic.db.is_enabled", return_value=True),
            patch("core.logic.db.is_anonymous_request_banned", return_value=True) as is_banned,
        ):
            self.assertTrue(await check_ban(interaction, {"10": {"channel_type": "request"}}))

        is_banned.assert_called_once_with("20")
        self.assertEqual(len(sent_messages), 1)
        self.assertIn("匿名要望", sent_messages[0]["embed"].description)

    async def test_request_report_revoke_button_is_first_and_request_only(self):
        from ui.views import ReportView

        request_ids = [item.custom_id for item in ReportView(is_request=True).children]
        normal_ids = [item.custom_id for item in ReportView(is_request=False).children]

        self.assertEqual(request_ids[0], "request_access_revoke_button")
        self.assertNotIn("request_access_revoke_button", normal_ids)


class DateTimeTests(unittest.TestCase):
    def test_naive_datetime_is_treated_as_utc(self):
        parsed = parse_datetime_utc("2026-01-01T12:00:00")
        self.assertEqual(parsed.utcoffset().total_seconds(), 0)

    def test_offset_datetime_is_converted_to_utc(self):
        parsed = parse_datetime_utc("2026-01-01T21:00:00+09:00")
        self.assertEqual(parsed.hour, 12)


class AtomicJsonTests(unittest.TestCase):
    def test_concurrent_writes_remain_valid_and_leave_no_temp_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "state.json")
            with patch("utils.json.db.is_enabled", return_value=False):
                threads = [
                    threading.Thread(
                        target=save_json,
                        args=(path, {"writer": index, "data": "x" * 1000}),
                    )
                    for index in range(25)
                ]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()

                result = load_json(path, {})
                self.assertIn(result["writer"], range(25))
                self.assertEqual(result["data"], "x" * 1000)
                self.assertFalse([name for name in os.listdir(directory) if name.endswith(".tmp")])
                with open(path, encoding="utf-8") as handle:
                    json.load(handle)


if __name__ == "__main__":
    unittest.main()
