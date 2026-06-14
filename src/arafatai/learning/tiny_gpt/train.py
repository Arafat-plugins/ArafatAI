"""Train a Tiny GPT model from a text file."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from time import time

from arafatai.learning.tiny_gpt.config import TinyGPTConfig
from arafatai.learning.tiny_gpt.data import make_batch, read_training_text, split_token_ids
from arafatai.learning.tiny_gpt.model import TinyGPT, torch
from arafatai.learning.tiny_gpt.tokenizer import CharTokenizer


def estimate_loss(model: TinyGPT, train_ids: list[int], val_ids: list[int], args: argparse.Namespace) -> dict[str, float]:
    model.eval()
    losses: dict[str, float] = {}
    for split, ids in {"train": train_ids, "val": val_ids}.items():
        values = []
        for _ in range(args.eval_iters):
            x, y = make_batch(ids, batch_size=args.batch_size, block_size=args.block_size, device=args.device)
            values.append(float(model(x, y).loss.item()))
        losses[split] = sum(values) / len(values)
    model.train()
    return losses


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tiny-gpt-train")
    parser.add_argument("--input", required=True, help="UTF-8 text file used for training.")
    parser.add_argument("--out-dir", default="runs/tiny-gpt", help="Directory for checkpoint and logs.")
    parser.add_argument("--max-steps", type=int, default=500)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--block-size", type=int, default=64)
    parser.add_argument("--n-layer", type=int, default=2)
    parser.add_argument("--n-head", type=int, default=2)
    parser.add_argument("--n-embd", type=int, default=64)
    parser.add_argument("--dropout", type=float, default=0.1)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--eval-interval", type=int, default=100)
    parser.add_argument("--eval-iters", type=int, default=10)
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    return parser


def main() -> None:
    args = build_parser().parse_args()
    text = read_training_text(args.input)
    tokenizer = CharTokenizer.from_text(text)
    token_ids = tokenizer.encode(text)
    train_ids, val_ids = split_token_ids(token_ids)

    config = TinyGPTConfig(
        vocab_size=tokenizer.vocab_size,
        block_size=args.block_size,
        n_layer=args.n_layer,
        n_head=args.n_head,
        n_embd=args.n_embd,
        dropout=args.dropout,
    )
    config.validate()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    tokenizer.save(out_dir / "tokenizer.json")
    config.save(out_dir / "config.json")

    model = TinyGPT(config).to(args.device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    metrics_path = out_dir / "metrics.jsonl"

    start = time()
    for step in range(args.max_steps + 1):
        if step % args.eval_interval == 0:
            losses = estimate_loss(model, train_ids, val_ids, args)
            row = {"step": step, "train_loss": losses["train"], "val_loss": losses["val"], "elapsed_seconds": round(time() - start, 2)}
            metrics_path.open("a", encoding="utf-8").write(json.dumps(row) + "\n")
            print(row)

        x, y = make_batch(train_ids, batch_size=args.batch_size, block_size=args.block_size, device=args.device)
        loss = model(x, y).loss
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()

    torch.save({"model": model.state_dict(), "config": config.to_dict()}, out_dir / "checkpoint.pt")
    print(f"saved checkpoint: {out_dir / 'checkpoint.pt'}")


if __name__ == "__main__":
    main()

