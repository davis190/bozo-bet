"""Candidate Bedrock models with on-demand prices (USD per 1M tokens, us-east-1).

Prices pulled from the AWS Price List API (service codes AmazonBedrock / AmazonBedrockFoundationModels)
on 2026-11-22. Refresh with: python evals/refresh_prices.py
Only models that passed the Converse + tool-use probe are listed.
"""

MODELS = {
    # id: (label, input $/1M, output $/1M, vision)
    "global.anthropic.claude-sonnet-4-6": ("Sonnet 4.6", 3.00, 15.00, True),
    "global.anthropic.claude-haiku-4-5-20251001-v1:0": ("Haiku 4.5", 1.00, 5.00, True),
    "us.amazon.nova-pro-v1:0": ("Nova Pro", 0.80, 3.20, True),
    "global.amazon.nova-2-lite-v1:0": ("Nova 2 Lite", 0.30, 2.50, True),
    "us.amazon.nova-lite-v1:0": ("Nova Lite", 0.06, 0.24, True),
    "us.amazon.nova-micro-v1:0": ("Nova Micro", 0.035, 0.14, False),
    "deepseek.v3.2": ("DeepSeek V3.2", 0.62, 1.85, False),
    "us.meta.llama4-maverick-17b-instruct-v1:0": ("Llama 4 Maverick", 0.24, 0.97, True),
    "us.meta.llama4-scout-17b-instruct-v1:0": ("Llama 4 Scout", 0.17, 0.66, True),
    "google.gemma-3-27b-it": ("Gemma 3 27B", 0.23, 0.38, True),
    "qwen.qwen3-next-80b-a3b": ("Qwen3 Next 80B", 0.14, 1.20, False),
    "qwen.qwen3-32b-v1:0": ("Qwen3 32B", 0.15, 0.60, False),
    "openai.gpt-oss-120b-1:0": ("gpt-oss-120b", 0.15, 0.60, False),
    "openai.gpt-oss-20b-1:0": ("gpt-oss-20b", 0.07, 0.30, False),
    "mistral.ministral-3-14b-instruct": ("Ministral 14B", 0.20, 0.20, False),
    "mistral.ministral-3-8b-instruct": ("Ministral 8B", 0.15, 0.15, False),
    "zai.glm-4.7-flash": ("GLM 4.7 Flash", 0.07, 0.40, False),
}

JUDGE = "global.anthropic.claude-sonnet-4-6"


def cost(model, input_tokens, output_tokens):
    _, pin, pout, _ = MODELS[model]
    return (input_tokens * pin + output_tokens * pout) / 1_000_000
