"""A tiny character tokenizer.

Character tokenization is not how strong modern LLMs tokenize text, but it is
the simplest correct first step for building a GPT training loop by hand.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path


@dataclass(frozen=True)
class CharTokenizer:
    vocab: tuple[str, ...]

    @classmethod
    def from_text(cls, text: str) -> "CharTokenizer":
        if not text:
            raise ValueError("Cannot build tokenizer from empty text.")
        return cls(tuple(sorted(set(text))))

    @classmethod
    def load(cls, path: str | Path) -> "CharTokenizer":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        vocab = data.get("vocab")
        if not isinstance(vocab, list) or not all(isinstance(item, str) for item in vocab):
            raise ValueError("Tokenizer file must contain a string vocab list.")
        return cls(tuple(vocab))

    @property
    def vocab_size(self) -> int:
        return len(self.vocab)

    @property
    def stoi(self) -> dict[str, int]:
        return {ch: index for index, ch in enumerate(self.vocab)}

    @property
    def itos(self) -> dict[int, str]:
        return {index: ch for index, ch in enumerate(self.vocab)}

    def encode(self, text: str) -> list[int]:
        lookup = self.stoi
        missing = sorted({ch for ch in text if ch not in lookup})
        if missing:
            display = "".join(missing[:10])
            raise ValueError(f"Text contains characters not in tokenizer vocab: {display!r}")
        return [lookup[ch] for ch in text]

    def decode(self, token_ids: list[int]) -> str:
        lookup = self.itos
        try:
            return "".join(lookup[token_id] for token_id in token_ids)
        except KeyError as exc:
            raise ValueError(f"Unknown token id: {exc.args[0]}") from exc

    def save(self, path: str | Path) -> None:
        output = Path(path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps({"type": "char", "vocab": list(self.vocab)}, indent=2), encoding="utf-8")

