"""Train and compare two transparent text-classification baselines.

Input CSV columns: description, category. Outputs model.joblib and metrics.json.
"""
import json
import sys
from pathlib import Path

import joblib
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline

data = pd.read_csv(sys.argv[1] if len(sys.argv) > 1 else "training-data.csv").dropna(subset=["description", "category"])
x_train, x_test, y_train, y_test = train_test_split(data.description, data.category, test_size=.2, stratify=data.category, random_state=42)
models = {
    "logistic_regression": Pipeline([("tfidf", TfidfVectorizer(ngram_range=(1, 2), min_df=2)), ("model", LogisticRegression(max_iter=1000))]),
    "random_forest": Pipeline([("tfidf", TfidfVectorizer(ngram_range=(1, 2), min_df=2)), ("model", RandomForestClassifier(n_estimators=250, random_state=42))]),
}
reports = {}
for name, model in models.items():
    model.fit(x_train, y_train)
    reports[name] = classification_report(y_test, model.predict(x_test), output_dict=True, zero_division=0)
best_name = max(models, key=lambda name: reports[name]["accuracy"])
joblib.dump(models[best_name], Path(__file__).with_name("model.joblib"))
Path(__file__).with_name("metrics.json").write_text(json.dumps({"selected": best_name, "reports": reports}, indent=2))
print(f"Selected {best_name}: {reports[best_name]['accuracy']:.1%} accuracy")
