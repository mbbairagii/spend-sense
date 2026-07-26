import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import multer from "multer";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { rateLimit } from "express-rate-limit";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10_000_000 } });
const ML_URL = process.env.ML_SERVICE_URL || "http://127.0.0.1:8000";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_NAME = process.env.MONGODB_DATABASE || "spend-sense";
const COOKIE_NAME = "spend_sense_session";
const CATEGORIES = ["Food & Dining","Shopping","Transport","Bills & Utilities","Rent","Entertainment","Health","Income","Other"];

if (!MONGODB_URI || !JWT_SECRET) console.warn("MONGODB_URI and JWT_SECRET are required for authentication.");
let databasePromise;
function database() {
  if (!MONGODB_URI) throw new Error("MongoDB is not configured.");
  if (!databasePromise) {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8_000, appName: "spend-sense" });
    databasePromise = client.connect().then(async () => {
      const db = client.db(DATABASE_NAME);
      await Promise.all([
        db.collection("users").createIndex({ email: 1 }, { unique: true }),
        db.collection("analyses").createIndex({ userId: 1, createdAt: -1 }),
        db.collection("auth_tokens").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      ]);
      return db;
    });
  }
  return databasePromise;
}

app.set("trust proxy", 1);
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    const localDevelopmentOrigin = process.env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin || "");
    callback(null, !origin || origin === FRONTEND_ORIGIN || localDevelopmentOrigin);
  },
}));
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 7 * 86400000, path: "/" };
const normalizeEmail = value => String(value || "").trim().toLowerCase();
const publicUser = user => ({ id: user._id.toString(), name: user.name, email: user.email, emailVerified: Boolean(user.emailVerified) });
const serializeTransaction = (transaction, index) => ({ id: String(transaction.id ?? index + 1), date: String(transaction.date || ""), description: String(transaction.description || "Unknown transaction"), amount: Number(transaction.amount || 0), category: CATEGORIES.includes(transaction.category) ? transaction.category : "Other", confidence: Number(transaction.confidence || 0), local: Boolean(transaction.local), corrected: Boolean(transaction.corrected) });
const serializeAnalysis = analysis => ({ id: analysis._id.toString(), fileName: analysis.fileName, summary: analysis.summary, categoryTotals: analysis.categoryTotals || {}, transactions: (analysis.transactions || []).map(serializeTransaction), model: analysis.model || null, metrics: analysis.metrics || null, createdAt: analysis.createdAt });
function createSession(res, user) { const token = jwt.sign({ sub: user._id.toString(), email: user.email }, JWT_SECRET, { expiresIn: "7d", issuer: "spend-sense" }); res.cookie(COOKIE_NAME, token, cookieOptions); }
async function currentUser(req) { if (!JWT_SECRET || !req.cookies[COOKIE_NAME]) return null; try { const payload = jwt.verify(req.cookies[COOKIE_NAME], JWT_SECRET, { issuer: "spend-sense" }); return (await database()).collection("users").findOne({ _id: new ObjectId(payload.sub) }, { projection: { passwordHash: 0 } }); } catch { return null; } }
async function requireUser(req, res, next) { try { const user = await currentUser(req); if (!user) return res.status(401).json({ error: "Please log in first." }); req.user = user; next(); } catch { res.status(503).json({ error: "Authentication database unavailable." }); } }
function issueToken() { const value = crypto.randomBytes(32).toString("hex"); return { value, hash: crypto.createHash("sha256").update(value).digest("hex") }; }

app.get("/health", async (_req, res) => { try { await (await database()).command({ ping: 1 }); res.json({ status: "ok", service: "spend-sense-api", database: true }); } catch { res.status(503).json({ status: "error", database: false }); } });
app.post("/api/auth/signup", authLimiter, async (req, res) => {
  try { const name=String(req.body.name||"").trim(), email=normalizeEmail(req.body.email), password=String(req.body.password||""); if(name.length<2||!/^\S+@\S+\.\S+$/.test(email)||password.length<8)return res.status(400).json({error:"Use a name, valid email, and password of at least 8 characters."}); const db=await database(); const passwordHash=await bcrypt.hash(password,12); const result=await db.collection("users").insertOne({name,email,passwordHash,emailVerified:false,createdAt:new Date(),updatedAt:new Date()}); const user={_id:result.insertedId,name,email,emailVerified:false}; const token=issueToken(); await db.collection("auth_tokens").insertOne({userId:user._id,type:"verify",tokenHash:token.hash,expiresAt:new Date(Date.now()+86400000),createdAt:new Date()}); createSession(res,user); res.status(201).json({user:publicUser(user),verificationToken:process.env.NODE_ENV==="production"?undefined:token.value}); } catch(error){if(error?.code===11000)return res.status(409).json({error:"An account with this email already exists."}); console.error("Signup failed",error);res.status(500).json({error:"Could not create the account."});}
});
app.post("/api/auth/login", authLimiter, async(req,res)=>{try{const email=normalizeEmail(req.body.email),password=String(req.body.password||""),db=await database();const user=await db.collection("users").findOne({email});if(!user||!(await bcrypt.compare(password,user.passwordHash)))return res.status(401).json({error:"Incorrect email or password."});createSession(res,user);res.json({user:publicUser(user)});}catch(error){console.error("Login failed",error);res.status(500).json({error:"Could not log in."});}});
app.get("/api/auth/me",async(req,res)=>{const user=await currentUser(req);res.json({user:user?publicUser(user):null});});
app.post("/api/auth/logout",(_req,res)=>{res.clearCookie(COOKIE_NAME,cookieOptions);res.status(204).end();});
app.post("/api/auth/verify",requireUser,async(req,res)=>{const hash=crypto.createHash("sha256").update(String(req.body.token||"")).digest("hex"),db=await database();const token=await db.collection("auth_tokens").findOneAndDelete({userId:req.user._id,type:"verify",tokenHash:hash,expiresAt:{$gt:new Date()}});if(!token)return res.status(400).json({error:"Invalid or expired verification token."});await db.collection("users").updateOne({_id:req.user._id},{$set:{emailVerified:true,updatedAt:new Date()}});res.json({verified:true});});
app.post("/api/auth/forgot-password",authLimiter,async(req,res)=>{const db=await database(),user=await db.collection("users").findOne({email:normalizeEmail(req.body.email)});let resetToken;if(user){const token=issueToken();resetToken=token.value;await db.collection("auth_tokens").deleteMany({userId:user._id,type:"reset"});await db.collection("auth_tokens").insertOne({userId:user._id,type:"reset",tokenHash:token.hash,expiresAt:new Date(Date.now()+3600000),createdAt:new Date()});}res.json({message:"If the account exists, a reset token was created.",resetToken:process.env.NODE_ENV==="production"?undefined:resetToken});});
app.post("/api/auth/reset-password",authLimiter,async(req,res)=>{const password=String(req.body.password||"");if(password.length<8)return res.status(400).json({error:"Password must be at least 8 characters."});const hash=crypto.createHash("sha256").update(String(req.body.token||"")).digest("hex"),db=await database();const token=await db.collection("auth_tokens").findOneAndDelete({type:"reset",tokenHash:hash,expiresAt:{$gt:new Date()}});if(!token)return res.status(400).json({error:"Invalid or expired reset token."});await db.collection("users").updateOne({_id:token.userId},{$set:{passwordHash:await bcrypt.hash(password,12),updatedAt:new Date()}});res.json({reset:true});});
app.delete("/api/account",requireUser,async(req,res)=>{const db=await database();await Promise.all([db.collection("analyses").deleteMany({userId:req.user._id}),db.collection("auth_tokens").deleteMany({userId:req.user._id}),db.collection("users").deleteOne({_id:req.user._id})]);res.clearCookie(COOKIE_NAME,cookieOptions);res.status(204).end();});

app.get("/api/analyses",requireUser,async(req,res)=>{const items=await (await database()).collection("analyses").find({userId:req.user._id}).sort({createdAt:-1}).limit(25).toArray();res.json({analyses:items.map(serializeAnalysis)});});
app.get("/api/analyses/:id",requireUser,async(req,res)=>{if(!ObjectId.isValid(req.params.id))return res.status(404).json({error:"Analysis not found."});const item=await (await database()).collection("analyses").findOne({_id:new ObjectId(req.params.id),userId:req.user._id});if(!item)return res.status(404).json({error:"Analysis not found."});res.json({analysis:serializeAnalysis(item)});});
app.patch("/api/analyses/:id/transactions/:transactionId",requireUser,async(req,res)=>{if(!ObjectId.isValid(req.params.id)||!CATEGORIES.includes(req.body.category))return res.status(400).json({error:"Invalid update."});const db=await database();const result=await db.collection("analyses").updateOne({_id:new ObjectId(req.params.id),userId:req.user._id,"transactions.id":req.params.transactionId},{$set:{"transactions.$.category":req.body.category,"transactions.$.confidence":1,"transactions.$.corrected":true,updatedAt:new Date()}});if(!result.matchedCount)return res.status(404).json({error:"Transaction not found."});res.json({updated:true});});
app.delete("/api/analyses/:id",requireUser,async(req,res)=>{if(ObjectId.isValid(req.params.id))await (await database()).collection("analyses").deleteOne({_id:new ObjectId(req.params.id),userId:req.user._id});res.status(204).end();});
app.post("/api/analyze",requireUser,upload.single("statement"),async(req,res)=>{if(!req.file)return res.status(400).json({error:"Attach a CSV, XLSX, or PDF file as 'statement'."});const extension=req.file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0];if(![".csv",".xlsx",".pdf"].includes(extension))return res.status(400).json({error:"Only CSV, XLSX, and PDF statements are supported."});try{const form=new FormData();form.append("statement",new Blob([req.file.buffer],{type:req.file.mimetype||"application/octet-stream"}),req.file.originalname);const response=await fetch(`${ML_URL}/analyze`,{method:"POST",body:form});const body=await response.json();if(!response.ok)return res.status(response.status).json(body);const transactions=(body.transactions||[]).map(serializeTransaction);const document={userId:req.user._id,fileName:req.file.originalname,summary:body.summary,categoryTotals:body.category_totals||{},transactions,model:body.model||null,metrics:body.metrics||null,createdAt:new Date(),updatedAt:new Date()};const db=await database();const result=await db.collection("analyses").insertOne(document);res.status(201).json({analysis:serializeAnalysis({...document,_id:result.insertedId})});}catch(error){console.error("Analysis failed",error);res.status(503).json({error:"The ML service is unavailable. Start the complete development stack."});}});
app.get("/api/model/metrics",requireUser,async(_req,res)=>{try{const response=await fetch(`${ML_URL}/metrics`);res.status(response.status).json(await response.json());}catch{res.status(503).json({error:"Model metrics unavailable."});}});

const port=Number(process.env.PORT||3001);app.listen(port,()=>console.log(`Spend Sense API listening on ${port}`));
