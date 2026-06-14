# Tiny GPT Learning Path

This part exists so Arafat can build an LLM by hand and understand the internals.

It is not the production assistant brain. The first value is learning.

## What It Teaches

- character tokenization
- token embeddings
- positional embeddings
- causal self-attention
- feed-forward blocks
- loss and backprop
- checkpoint save/load
- text generation

## Install

```bash
python -m pip install -e .[llm]
```

## Train

```bash
python -m arafatai.learning.tiny_gpt.train \
  --input examples/tiny-gpt/sample.txt \
  --out-dir runs/tiny-gpt \
  --max-steps 200 \
  --device cpu
```

## Generate

```bash
python -m arafatai.learning.tiny_gpt.generate \
  --checkpoint-dir runs/tiny-gpt \
  --prompt "ArafatAI"
```

## Reality Check

Tiny GPT can learn patterns from a tiny dataset. It will not become ChatGPT.

The practical AI grows through memory, RAG, tools, evals, and PR-gated workflow.
Fine-tuning and larger local models can come later.

