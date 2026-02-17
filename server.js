
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for larger state objects
app.use(express.static(path.join(__dirname, 'dist')));

// --- MongoDB Schema & Model ---
// We now store an 'appId' to distinguish between different applications
const appDataSchema = new mongoose.Schema({
    appId: { type: String, required: true, unique: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} } // Stores the entire JSON state of the app
}, { timestamps: true });

const AppData = mongoose.model('AppData', appDataSchema);

// --- Default Templates ---
const INITIAL_PKGEN_DB = {
    version: 1,
    users: {},
    admin: {
        paymentRequests: [],
        treasury: {
            evm: "0xb53D334BD9B3E635f5A461f26F660dC0944e98B1",
            btc: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
            ltc: "LQtpSB2b8b9j3cZ7n3v6g8e5h6y4d2f1"
        },
        pricing: {
            "Free": { tier: "Free", maxSpeed: 10, maxWorkers: 1, priceEth: 0, priceUsd: 0 },
            "Pro": { tier: "Pro", maxSpeed: 1000, maxWorkers: 4, priceEth: 0.05, priceUsd: 150 },
            "Premium": { tier: "Premium", maxSpeed: 100000, maxWorkers: 16, priceEth: 0.15, priceUsd: 450 }
        }
    }
};

const GENERIC_DEFAULT_DB = {
    version: 1,
    note: "Initialized new app storage",
    data: {}
};

// --- Initialization Logic ---
async function connectDB() {
    try {
        const mongoUri = process.env.MONGODB_URI;
        if (!mongoUri) {
            console.error("FATAL: MONGODB_URI environment variable is not defined.");
            process.exit(1);
        }

        await mongoose.connect(mongoUri);
        console.log('Connected to MongoDB');
    } catch (err) {
        console.error('MongoDB connection error:', err);
    }
}

connectDB();

// --- Helper Functions ---
const getInitialDataForApp = (appId) => {
    // You can define custom templates for specific app IDs here
    if (appId.startsWith('pkgen')) {
        return INITIAL_PKGEN_DB;
    }
    return GENERIC_DEFAULT_DB;
};

// --- Routes ---

// 0. Health Check / Ping (for keep-alive)
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// 1. GET /:appId/database.json - Read the DB state for a specific app
app.get('/:appId/database.json', async (req, res) => {
    const { appId } = req.params;

    // specific restriction to prevent abuse
    if (appId.length > 50 || /[^a-zA-Z0-9-_]/.test(appId)) {
        return res.status(400).json({ error: "Invalid App ID" });
    }

    try {
        let doc = await AppData.findOne({ appId }).lean();

        // Lazy Initialization: If app doesn't exist, create it with default template
        if (!doc) {
            console.log(`Initializing new database for appId: ${appId}`);
            const initialPayload = getInitialDataForApp(appId);
            doc = await AppData.create({
                appId,
                payload: initialPayload
            });
            // Return payload immediately
            return res.json(initialPayload);
        }

        // Return only the payload (the actual app data)
        res.json(doc.payload);
    } catch (err) {
        console.error(`Read Error (${appId}):`, err);
        res.status(500).json({ error: "Failed to read database" });
    }
});

// 2. POST /:appId/save-db - Update the DB state for a specific app
app.post('/:appId/save-db', async (req, res) => {
    const { appId } = req.params;

    try {
        const newData = req.body;

        if (!newData) {
            return res.status(400).json({ error: "No data provided" });
        }

        // Update the payload for the specific appId
        await AppData.findOneAndUpdate(
            { appId },
            { $set: { payload: newData } },
            { upsert: true, new: true }
        );

        res.json({ success: true, timestamp: Date.now() });
    } catch (err) {
        console.error(`Write Error (${appId}):`, err);
        res.status(500).json({ error: "Failed to save database" });
    }
});

// 3. BACKWARD COMPATIBILITY ROUTES (For old clients hitting root)
// Maps root requests to 'pkgen-legacy'
app.get('/database.json', async (req, res) => {
    res.redirect('/pkgen-legacy/database.json');
});

app.post('/api/save-db', async (req, res) => {
    // Internally forward to the legacy ID handler logic
    req.params.appId = 'pkgen-legacy';
    // We cannot use res.redirect for POST with body easily without 307, 
    // so we just run the logic directly or fetch-forward. 
    // Easiest is to duplicate logic or forward internally:
    try {
        await AppData.findOneAndUpdate(
            { appId: 'pkgen-legacy' },
            { $set: { payload: req.body } },
            { upsert: true, new: true }
        );
        res.json({ success: true, timestamp: Date.now() });
    } catch (e) {
        res.status(500).json({ error: "Legacy save failed" });
    }
});

// 4. Serve Frontend (Catch-all)
app.get('*', (req, res) => {
    res.status(404).send('API Server Running. Use /:your-app-id/database.json to sync data.');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

    // --- Keep-Alive Mechanism ---
    // Pings the server every 14 minutes to prevent sleep on free tier (e.g., Render)
    const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes
    // Render provides the external URL in env, or we default to localhost
    const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

    console.log(`Keep-alive enabled. Target: ${SELF_URL}`);

    setInterval(() => {
        const protocol = SELF_URL.startsWith('https') ? require('https') : require('http');

        protocol.get(`${SELF_URL}/ping`, (res) => {
            // Consume the response data to free up memory
            res.resume();
            // Optional: console.log(`Keep-alive ping status: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error(`Keep-alive failed: ${err.message}`);
        });
    }, PING_INTERVAL);
});
