from __future__ import annotations

import io
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Annotated

import joblib
import pandas as pd
import pdfplumber
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

ROOT = Path(__file__).parent
MODEL_PATH = ROOT / "model.joblib"
METRICS_PATH = ROOT / "metrics.json"
app = FastAPI(title="Spend Sense ML", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000"], allow_methods=["*"], allow_headers=["*"])

RULES = {
    "Income": r"salary|payroll|interest|refund|credit",
    "Rent": r"rent|landlord|housing",
    "Food & Dining": r"zomato|swiggy|restaurant|cafe|coffee|kitchen|food|dining|bakery",
    "Transport": r"uber|ola|metro|fuel|petrol|rapido|railway|irctc",
    "Shopping": r"amazon|flipkart|myntra|store|mall|retail",
    "Bills & Utilities": r"bescom|electric|utility|broadband|airtel|jio|water|bill",
    "Entertainment": r"netflix|spotify|cinema|pvr|movie|prime video|hotstar",
    "Health": r"medical|pharmacy|hospital|clinic|apollo",
}
BRANDS = re.compile(r"amazon|zomato|swiggy|uber|ola|netflix|spotify|pvr|airtel|jio|flipkart|myntra", re.I)
MODEL = joblib.load(MODEL_PATH) if MODEL_PATH.exists() else None

def predict(description: str) -> tuple[str, float]:
    if MODEL is not None:
        category = str(MODEL.predict([description])[0])
        confidence = float(max(MODEL.predict_proba([description])[0])) if hasattr(MODEL, "predict_proba") else 0.8
        return category, confidence
    cleaned = re.sub(r"[^a-z0-9 ]", " ", description.lower())
    for category, pattern in RULES.items():
        if re.search(pattern, cleaned):
            return category, 0.91
    return "Other", 0.60

def find_column(columns, pattern):
    return next((column for column in columns if re.search(pattern, str(column), re.I)), None)

def read_pdf(data: bytes) -> pd.DataFrame:
    with pdfplumber.open(io.BytesIO(data)) as document:
        for page in document.pages:
            for table in page.extract_tables():
                if len(table) < 2:
                    continue
                headers = [re.sub(r"\s+", " ", str(value or "")).strip() for value in table[0]]
                if find_column(headers, r"description|narration|merchant|details") and (
                    find_column(headers, r"amount|value") or find_column(headers, r"debit|withdrawal|credit|deposit")
                ):
                    return pd.DataFrame(table[1:], columns=headers)

        rows = []
        line_pattern = re.compile(
            r"^\s*(?P<date>\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\s+"
            r"(?P<description>.+?)\s+(?P<amount>\(?[-+]?\s*(?:₹|Rs\.?\s*)?[\d,]+(?:\.\d{1,2})?\)?(?:\s*(?:CR|DR))?)\s*$",
            re.I,
        )
        for page in document.pages:
            for line in (page.extract_text() or "").splitlines():
                match = line_pattern.match(line)
                if match:
                    rows.append(match.groupdict())
        if rows:
            return pd.DataFrame(rows)
    raise ValueError("No transaction table or recognizable transaction rows were found in this PDF")

def read_statement(filename: str, data: bytes) -> pd.DataFrame:
    extension = Path(filename).suffix.lower()
    if extension == ".csv":
        return pd.read_csv(io.BytesIO(data))
    if extension == ".xlsx":
        sheets = pd.read_excel(io.BytesIO(data), sheet_name=None, header=None, engine="openpyxl")
        for raw in sheets.values():
            if raw.empty:
                continue
            for row_index in range(min(50, len(raw))):
                headers = [re.sub(r"\s+", " ", str(value if not pd.isna(value) else "")).strip() for value in raw.iloc[row_index]]
                has_description = find_column(headers, r"description|narration|merchant|details|particulars|transaction remarks") is not None
                has_amount = find_column(headers, r"amount|value|debit|withdrawal|credit|deposit") is not None
                if not (has_description and has_amount):
                    continue
                unique_headers, seen = [], {}
                for index, header in enumerate(headers):
                    name = header or f"column_{index + 1}"
                    seen[name] = seen.get(name, 0) + 1
                    unique_headers.append(name if seen[name] == 1 else f"{name}_{seen[name]}")
                frame = raw.iloc[row_index + 1:].copy()
                frame.columns = unique_headers
                return frame.dropna(how="all").reset_index(drop=True)
        raise ValueError("Could not find a transaction header row in the first 50 rows of any worksheet")
    if extension == ".pdf":
        return read_pdf(data)
    raise ValueError("Unsupported file type")

def parse_amount(value) -> float:
    text = re.sub(r"(?:₹|Rs\.?)", "", str(value or ""), flags=re.I).strip()
    negative = text.startswith("(") or bool(re.search(r"\bDR\b", text, re.I))
    text = re.sub(r"[(),+\s]|\b(?:CR|DR)\b", "", text, flags=re.I)
    number = pd.to_numeric(text.replace(",", ""), errors="coerce")
    if pd.isna(number):
        return float("nan")
    return -abs(float(number)) if negative else float(number)

def spending_summary(transactions, totals):
    expenses = sum(totals.values())
    expense_count = sum(1 for item in transactions if item["amount"] < 0)
    if not expenses:
        return "No expenses were found in this statement."
    top = max(totals, key=totals.get)
    share = round(totals[top] / expenses * 100)
    return f"You spent ₹{expenses:,.0f} across {expense_count} purchases. {top} was the largest category at {share}% of spending."

@app.get("/health")
def health():
    return {"status": "ok", "model": "trained-classifier" if MODEL is not None else "explainable-rule-baseline-v2"}

@app.get("/metrics")
def metrics():
    if not METRICS_PATH.exists():
        return {"trained": False, "accuracy": None, "message": "Train with a labeled dataset to produce measured metrics."}
    data = json.loads(METRICS_PATH.read_text())
    selected = data.get("selected")
    report = data.get("reports", {}).get(selected, {})
    return {"trained": True, "selected": selected, "accuracy": report.get("accuracy"), "report": report}

@app.post("/analyze")
async def analyze(statement: Annotated[UploadFile, File()]):
    if not statement.filename or Path(statement.filename).suffix.lower() not in {".csv", ".xlsx", ".pdf"}:
        raise HTTPException(400, "Upload a CSV, XLSX, or text-based PDF statement.")
    try:
        frame = read_statement(statement.filename, await statement.read())
    except Exception as exc:
        raise HTTPException(400, f"Could not read statement: {exc}") from exc
    if frame.empty or len(frame) > 10_000:
        raise HTTPException(400, "The statement must contain between 1 and 10,000 transactions.")
    desc_col = find_column(frame.columns, r"description|narration|merchant|details|particulars|transaction remarks")
    date_col = find_column(frame.columns, r"date")
    debit_col = find_column(frame.columns, r"debit|withdrawal")
    credit_col = find_column(frame.columns, r"credit|deposit")
    amount_col = next((column for column in frame.columns if re.search(r"amount|value", str(column), re.I)
                       and not re.search(r"debit|withdrawal|credit|deposit|balance", str(column), re.I)), None)
    if desc_col is None or (amount_col is None and debit_col is None and credit_col is None):
        raise HTTPException(400, "The statement needs a description column and either amount or debit/credit columns.")
    output, totals = [], defaultdict(float)
    for index, row in frame.iterrows():
        description = str(row.get(desc_col, "Unknown transaction"))
        if amount_col is not None:
            amount = parse_amount(row.get(amount_col, 0))
        else:
            credit = parse_amount(row.get(credit_col, 0) if credit_col else 0)
            debit = parse_amount(row.get(debit_col, 0) if debit_col else 0)
            amount = (0 if pd.isna(credit) else credit) - (0 if pd.isna(debit) else debit)
        if pd.isna(amount):
            continue
        category, confidence = predict(description)
        amount = float(amount)
        if amount < 0:
            totals[category] += abs(amount)
        output.append({"id": str(index + 1), "date": str(row.get(date_col, "")) if date_col else "", "description": description,
                       "amount": amount, "category": category, "confidence": round(confidence, 4), "local": not bool(BRANDS.search(description)), "corrected": False})
    if not output:
        raise HTTPException(400, "No valid transactions were found.")
    metric_data = metrics()
    return {"transactions": output, "summary": spending_summary(output, totals), "category_totals": dict(totals),
            "model": health()["model"], "metrics": {"accuracy": metric_data.get("accuracy"), "trained": metric_data.get("trained")}}
