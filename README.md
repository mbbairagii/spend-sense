# Spend Sense

Spend Sense turns a bank-statement CSV, XLSX, or text-based PDF into categorized transactions, a spending dashboard, a plain-English summary, and a fairness check comparing confidence for local merchants with recognized brands.

## What works

- MongoDB-backed signup, login, sessions, development verification/reset tokens, sign-out, and full account deletion
- Authenticated CSV, XLSX, and PDF upload through Express to FastAPI
- Flexible spreadsheet columns: `date`, `description`/`merchant`, and `amount`, or separate `debit` and `credit` columns
- PDF table extraction with a text-line fallback; scanned/image-only PDFs require OCR before upload
- Nine transaction categories, editable corrections, search, totals, breakdowns, and generated summaries
- Saved analysis history scoped to each account
- Local-vs-known-merchant confidence comparison with an explicit confidence-versus-accuracy warning
- Optional supervised model training with accuracy, precision, recall, F1, and confusion-matrix output

## Run everything

Requirements: Node.js/npm, Python 3.9+, and the configured `server/.env` file.

```bash
npm install
npm --prefix server install
python3 -m venv ml-service/.venv
ml-service/.venv/bin/pip install -r ml-service/requirements.txt
npm run dev
```

Open the frontend URL printed in the terminal. Normally it is `http://localhost:3000`; if that port is already occupied, Vinext prints the next available port. Use `examples/sample-statement.csv` for a quick test.

`npm run dev` starts the frontend, Express API on port 3001, and FastAPI service on port 8000. Stop all three with `Control+C` in the same terminal.

## Environment

`server/.env` must contain:

```dotenv
MONGODB_URI=your-mongodb-connection-string
MONGODB_DATABASE=spend-sense
JWT_SECRET=a-long-random-secret
FRONTEND_ORIGIN=http://localhost:3000
ML_SERVICE_URL=http://127.0.0.1:8000
PORT=3001
```

The application uses the `users`, `analyses`, and `auth_tokens` collections. Never commit `server/.env`.

## Model accuracy

The app currently uses the explainable rule baseline unless `ml-service/model.joblib` exists. A rule baseline does not have an honest measured accuracy without a separate labeled test set, so the UI reports confidence—not accuracy.

To train and measure a supervised model, prepare a labeled CSV containing `description` and `category`, then run:

```bash
ml-service/.venv/bin/python ml-service/train.py path/to/training-data.csv
```

The selected model is saved to `ml-service/model.joblib`. Accuracy, per-class precision/recall/F1, and the confusion matrix are saved to `ml-service/metrics.json` and exposed through the authenticated `/api/model/metrics` endpoint.

## Architecture

- Next/Vinext: account UI, upload flow, dashboard, transaction editing, fairness view
- Express: authentication, secure cookies, upload validation, MongoDB persistence, FastAPI proxy
- FastAPI: CSV/XLSX/PDF extraction and cleaning, categorization, confidence values, summaries, and model metrics
