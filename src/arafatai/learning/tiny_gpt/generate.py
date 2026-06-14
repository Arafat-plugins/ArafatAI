"""Generate text from a Tiny GPT checkpoint."""

from __future__ import annotations

import argparse
from pathlib import Path

from arafatai.learning.tiny_gpt.config import TinyGPTConfig
from arafatai.learning.tiny_gpt.model import TinyGPT, torch
from arafatai.learning.tiny_gpt.tokenizer import CharTokenizer


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tiny-gpt-generate")
    parser.add_argument("--checkpoint-dir", default="runs/tiny-gpt")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--max-new-tokens", type=int, default=120)
    parser.add_argument("--temperature", type=float, default=0.8)
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    return parser


def main() -> None:
    args = build_parser().parse_args()
    checkpoint_dir = Path(args.checkpoint_dir)
    tokenizer = CharTokenizer.load(checkpoint_dir / "tokenizer.json")
    config = TinyGPTConfig.load(checkpoint_dir / "config.json")
    checkpoint = torch.load(checkpoint_dir / "checkpoint.pt", map_location=args.device)

    model = TinyGPT(config).to(args.device)
    model.load_state_dict(checkpoint["model"])
    model.eval()

    encoded = tokenizer.encode(args.prompt)
    idx = torch.tensor([encoded], dtype=torch.long, device=args.device)
    generated = model.generate(
        idx,
        max_new_tokens=args.max_new_tokens,
        temperature=args.temperature,
        top_k=args.top_k,
    )[0].tolist()
    print(tokenizer.decode(generated))


if __name__ == "__main__":
    main()

