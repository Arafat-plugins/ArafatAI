"""Small GPT model implemented with PyTorch."""

from __future__ import annotations

from dataclasses import dataclass

from arafatai.learning.tiny_gpt.config import TinyGPTConfig


def require_torch():
    try:
        import torch
        import torch.nn as nn
        import torch.nn.functional as functional
    except ImportError as exc:
        raise RuntimeError(
            "Tiny GPT training requires PyTorch. Install with: python -m pip install -e .[llm]"
        ) from exc
    return torch, nn, functional


torch, nn, F = require_torch()


class CausalSelfAttention(nn.Module):
    def __init__(self, config: TinyGPTConfig) -> None:
        super().__init__()
        if config.n_embd % config.n_head != 0:
            raise ValueError("n_embd must be divisible by n_head.")
        self.n_head = config.n_head
        self.head_size = config.n_embd // config.n_head
        self.key = nn.Linear(config.n_embd, config.n_embd, bias=config.bias)
        self.query = nn.Linear(config.n_embd, config.n_embd, bias=config.bias)
        self.value = nn.Linear(config.n_embd, config.n_embd, bias=config.bias)
        self.proj = nn.Linear(config.n_embd, config.n_embd, bias=config.bias)
        self.attn_dropout = nn.Dropout(config.dropout)
        self.resid_dropout = nn.Dropout(config.dropout)
        self.register_buffer(
            "tril",
            torch.tril(torch.ones(config.block_size, config.block_size)).view(1, 1, config.block_size, config.block_size),
        )

    def forward(self, x):
        batch, time, channels = x.shape
        key = self.key(x).view(batch, time, self.n_head, self.head_size).transpose(1, 2)
        query = self.query(x).view(batch, time, self.n_head, self.head_size).transpose(1, 2)
        value = self.value(x).view(batch, time, self.n_head, self.head_size).transpose(1, 2)

        weights = query @ key.transpose(-2, -1) * (self.head_size ** -0.5)
        weights = weights.masked_fill(self.tril[:, :, :time, :time] == 0, float("-inf"))
        weights = F.softmax(weights, dim=-1)
        weights = self.attn_dropout(weights)

        out = weights @ value
        out = out.transpose(1, 2).contiguous().view(batch, time, channels)
        return self.resid_dropout(self.proj(out))


class FeedForward(nn.Module):
    def __init__(self, config: TinyGPTConfig) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(config.n_embd, 4 * config.n_embd, bias=config.bias),
            nn.GELU(),
            nn.Linear(4 * config.n_embd, config.n_embd, bias=config.bias),
            nn.Dropout(config.dropout),
        )

    def forward(self, x):
        return self.net(x)


class Block(nn.Module):
    def __init__(self, config: TinyGPTConfig) -> None:
        super().__init__()
        self.ln1 = nn.LayerNorm(config.n_embd)
        self.attn = CausalSelfAttention(config)
        self.ln2 = nn.LayerNorm(config.n_embd)
        self.ffwd = FeedForward(config)

    def forward(self, x):
        x = x + self.attn(self.ln1(x))
        x = x + self.ffwd(self.ln2(x))
        return x


@dataclass
class TinyGPTOutput:
    logits: object
    loss: object | None


class TinyGPT(nn.Module):
    def __init__(self, config: TinyGPTConfig) -> None:
        super().__init__()
        config.validate()
        self.config = config
        self.token_embedding = nn.Embedding(config.vocab_size, config.n_embd)
        self.position_embedding = nn.Embedding(config.block_size, config.n_embd)
        self.blocks = nn.Sequential(*[Block(config) for _ in range(config.n_layer)])
        self.ln_f = nn.LayerNorm(config.n_embd)
        self.lm_head = nn.Linear(config.n_embd, config.vocab_size, bias=False)
        self.apply(self._init_weights)

    def _init_weights(self, module) -> None:
        if isinstance(module, nn.Linear):
            torch.nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if module.bias is not None:
                torch.nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            torch.nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def forward(self, idx, targets=None) -> TinyGPTOutput:
        batch, time = idx.shape
        if time > self.config.block_size:
            raise ValueError("Cannot forward sequence longer than block_size.")

        positions = torch.arange(0, time, dtype=torch.long, device=idx.device)
        x = self.token_embedding(idx) + self.position_embedding(positions)
        x = self.blocks(x)
        x = self.ln_f(x)
        logits = self.lm_head(x)

        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.view(batch * time, -1), targets.view(batch * time))
        return TinyGPTOutput(logits=logits, loss=loss)

    @torch.no_grad()
    def generate(self, idx, *, max_new_tokens: int, temperature: float = 1.0, top_k: int | None = None):
        for _ in range(max_new_tokens):
            idx_cond = idx[:, -self.config.block_size :]
            logits = self(idx_cond).logits[:, -1, :] / temperature
            if top_k is not None:
                values, _ = torch.topk(logits, min(top_k, logits.size(-1)))
                logits[logits < values[:, [-1]]] = -float("inf")
            probs = F.softmax(logits, dim=-1)
            idx_next = torch.multinomial(probs, num_samples=1)
            idx = torch.cat((idx, idx_next), dim=1)
        return idx

