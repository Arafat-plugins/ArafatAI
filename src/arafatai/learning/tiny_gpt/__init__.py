"""Tiny GPT learning project.

This package is intentionally small and explicit. It is for learning how a GPT
style language model works, not for competing with production LLMs.
"""

from arafatai.learning.tiny_gpt.config import TinyGPTConfig
from arafatai.learning.tiny_gpt.tokenizer import CharTokenizer

__all__ = ["CharTokenizer", "TinyGPTConfig"]

