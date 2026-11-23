"""Dump on-demand per-token Bedrock prices (us-east-1) from the AWS Price List API.

    AWS_PROFILE=... python evals/refresh_prices.py prices.json

Then update the $/1M numbers in evals/models.py from the dump.
"""
import json
import sys

import boto3

s = boto3.Session(region_name="us-east-1")
pricing = s.client("pricing")
out = {}
for svc in ("AmazonBedrock", "AmazonBedrockFoundationModels"):
    pages = pricing.get_paginator("get_products").paginate(
        ServiceCode=svc, Filters=[{"Type": "TERM_MATCH", "Field": "regionCode", "Value": "us-east-1"}])
    for page in pages:
        for raw in page["PriceList"]:
            p = json.loads(raw)
            a = p["product"]["attributes"]
            it = (a.get("inferenceType") or "").lower()
            ut = a.get("usagetype", "")
            if "batch" in it or "batch" in ut.lower() or "cache" in ut.lower() or "flex" in ut.lower() or "priority" in ut.lower():
                continue
            for term in p["terms"].get("OnDemand", {}).values():
                for dim in term["priceDimensions"].values():
                    usd = float(dim["pricePerUnit"].get("USD", 0))
                    desc = dim["description"]
                    out.setdefault(svc, []).append({"usagetype": ut, "model": a.get("model") or a.get("titleModel") or a.get("servicename"),
                                                    "inferenceType": it, "unit": dim["unit"], "usd": usd, "desc": desc[:140]})
json.dump(out, open(sys.argv[1], "w"), indent=1)
for svc, rows in out.items():
    print(svc, len(rows))
