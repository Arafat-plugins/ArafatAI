"""Data helpers for Tiny GPT training."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import torch


def read_training_text(path: str | Path) -> str:
    text = Path(path).read_text(encoding="utf-8")
    if len(text) < 100:
        raise ValueError("Training text should be at least 100 characters for a useful run.")
    return text


def split_token_ids(token_ids: list[int], train_ratio: float = 0.9) -> tuple[list[int], list[int]]:
    if not 0 < train_ratio < 1:
        raise ValueError("train_ratio must be between 0 and 1.")
    if len(token_ids) < 20:
        raise ValueError("Need at least 20 token ids.")
    split_at = max(1, min(len(token_ids) - 1, int(len(token_ids) * train_ratio)))
    return token_ids[:split_at], token_ids[split_at:]


def make_batch(
    ids: list[int],
    *,
    batch_size: int,
    block_size: int,
    device: str,
) -> tuple["torch.Tensor", "torch.Tensor"]:
    import torch

    if len(ids) <= block_size:
        raise ValueError("Dataset must be longer than block_size.")
    starts = torch.randint(len(ids) - block_size - 1, (batch_size,))
    x = torch.stack([torch.tensor(ids[i : i + block_size], dtype=torch.long) for i in starts])
    y = torch.stack([torch.tensor(ids[i + 1 : i + block_size + 1], dtype=torch.long) for i in starts])
    return x.to(device), y.to(device)

