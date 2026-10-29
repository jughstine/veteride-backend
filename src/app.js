const express = require("express");
const helmet = require("helmet");
const cors = require("cors");

const authRoutes = require("./modules/auth/auth.routes");
const profileRoutes = require("./modules/profile/profile.routes");
const driversRoutes = require("./modules/drivers/drivers.routes");
const paymongoWebhookRoutes = require("./modules/wallet/webhook.routes");
const walletReturnRoutes = require("./modules/wallet/return.routes");
const tripsRoutes = require("./modules/trips/trips.routes");
const uploadsRoutes = require("./modules/uploads/uploads.routes");
const adminRoutes = require("./modules/admin/admin.routes");
const streamRoutes = require("./realtime/stream.routes");

const errorHandler = require("./middleware/errorHandler");

const app = express();

app.set("trust proxy", 1); // needed for req.ip / rate-limit to see the real client IP behind a proxy/load balancer

app.use(helmet());
app.use(cors());
// BEFORE express.json(): PayMongo signs the RAW bytes, and a body that has
// been parsed and re-serialised no longer matches its own signature. This
// router brings its own express.raw().
app.use("/webhooks", paymongoWebhookRoutes);

app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

// PayMongo sends the driver's browser here after they pay. Serving a
// page rather than the API 404 they used to land on.
app.use("/wallet", walletReturnRoutes);
app.use("/auth", authRoutes);
app.use("/me", profileRoutes);
app.use("/drivers", driversRoutes);
app.use("/trips", tripsRoutes);
app.use("/uploads", uploadsRoutes);
app.use("/admin", adminRoutes);
app.use("/stream", streamRoutes);

app.use((req, res) => {
  res
    .status(404)
    .json({ error: { code: "NOT_FOUND", message: "Route not found" } });
});

app.use(errorHandler);

module.exports = app;
