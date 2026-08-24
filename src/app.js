require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const app = express();

// Security headers (protects against some common attacks)
app.use(helmet());
app.use(cors());

// Parses incoming JSON request bodies into req.body
app.use(express.json());

// A simple test route so we know the app works before adding real features
app.get("/api/veteride/health", (req, res) => {
  res.json({ success: true, data: { status: "ok" } });
});

module.exports = app;
