import pytest

from arafatai.learning.tiny_gpt.config import TinyGPTConfig
from arafatai.learning.tiny_gpt.tokenizer import CharTokenizer


def test_char_tokenizer_round_trip():
    tokenizer = CharTokenizer.from_text("hello world")
    encoded = tokenizer.encode("hello")
    assert tokenizer.decode(encoded) == "hello"


def test_char_tokenizer_rejects_unknown_character():
    tokenizer = CharTokenizer.from_text("abc")
    with pytest.raises(ValueError):
        tokenizer.encode("abcd")


def test_tiny_gpt_config_validates_head_size():
    config = TinyGPTConfig(vocab_size=10, n_head=3, n_embd=8)
    with pytest.raises(ValueError):
        config.validate()

