"""LLM client placeholder.

The first implementation will add a provider client and force JSON action
responses. API keys must come from environment variables, never committed files.
"""

from __future__ import annotations


class LLMClient:
    """Placeholder for provider-specific LLM calls."""

    def complete(self, prompt: str) -> str:
        raise NotImplementedError("LLM provider is not implemented yet.")
