"""Configuration for the Tiny GPT learning model."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from pathlib import Path


@dataclass(frozen=True)
class TinyGPTConfig:
    vocab_size: int
    block_size: int = 64
    n_layer: int = 2
    n_head: int = 2
    n_embd: int = 64
    dropout: float = 0.1
    bias: bool = True

    def validate(self) -> None:
        if self.vocab_size <= 0:
            raise ValueError("vocab_size must be positive.")
        if self.block_size <= 0:
            raise ValueError("block_size must be positive.")
        if self.n_layer <= 0:
            raise ValueError("n_layer must be positive.")
        if self.n_head <= 0:
            raise ValueError("n_head must be positive.")
        if self.n_embd <= 0:
            raise ValueError("n_embd must be positive.")
        if self.n_embd % self.n_head != 0:
            raise ValueError("n_embd must be divisible by n_head.")
        if not 0 <= self.dropout < 1:
            raise ValueError("dropout must be between 0 and 1.")

    def to_dict(self) -> dict[str, int | float | bool]:
        return asdict(self)

    def save(self, path: str | Path) -> None:
        self.validate()
        output = Path(path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")

    @classmethod
    def load(cls, path: str | Path) -> "TinyGPTConfig":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        config = cls(**data)
        config.validate()
        return config

