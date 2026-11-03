const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const puppeteer = require('puppeteer-core');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/login.html'));

// Nạp @sparticuz/chromium bằng dynamic import (chạy được cả khi gói là CJS hoặc ESM)
let chromiumCache = null;
async function getChromium() {
    if (!chromiumCache) {
        const mod = await import('@sparticuz/chromium');
        chromiumCache = mod.default || mod;
    }
    return chromiumCache;
}

// ================= KẾT NỐI MONGODB (tối ưu cho serverless) =================
let dbPromise = null;
function connectDB() {
    if (mongoose.connection.readyState === 1) return Promise.resolve();
    if (!dbPromise) {
        dbPromise = mongoose
            .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 })
            .then(() => console.log('✅ Đã kết nối MongoDB Atlas thành công!'))
            .catch(err => {
                dbPromise = null;
                console.error('❌ Lỗi kết nối MongoDB:', err.message);
                throw err;
            });
    }
    return dbPromise;
}

// Mọi request /api đều đảm bảo DB đã kết nối trước
app.use('/api', async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (e) {
        res.status(500).json({ error: 'Không kết nối được database: ' + e.message });
    }
});

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    role: { type: String, default: 'user' },
    plan: { type: String, default: 'free' },
    dailyUses: { type: Number, default: 0 },
    lastUsedDate: { type: String, default: '' },
    planExpiry: { type: Date, default: null }
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

const PaymentSchema = new mongoose.Schema({
    username: String,
    plan: String,
    amount: Number,
    status: { type: String, default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});
const Payment = mongoose.models.Payment || mongoose.model('Payment', PaymentSchema);

// Tự động tạo Admin (mật khẩu lấy từ biến môi trường ADMIN_PASSWORD)
async function initAdmin() {
    try {
        if (!process.env.ADMIN_PASSWORD) {
            console.warn('⚠️ Chưa đặt ADMIN_PASSWORD nên bỏ qua việc tạo admin mặc định.');
            return;
        }
        await connectDB();
        const admin = await User.findOne({ username: 'bindev' });
        if (!admin) {
            const salt = await bcrypt.genSalt(10);
            const hashPass = await bcrypt.hash(process.env.ADMIN_PASSWORD, salt);
            await User.create({ username: 'bindev', password: hashPass, role: 'admin' });
            console.log('👑 Đã khởi tạo tài khoản Admin mặc định thành công!');
        }
    } catch (e) {
        console.error('Lỗi khởi tạo Admin:', e.message);
    }
}
initAdmin();

const getToday = () => new Date().toISOString().split('T')[0];
const LIMITS = { free: 5, '50k': 15, '100k': 30, '200k': 999999 };

const auth = (req, res, next) => {
    const authHeader = req.header('Authorization');
    if (!authHeader) return res.status(401).json({ error: 'Vui lòng đăng nhập' });

    const parts = authHeader.split(' ');
    if (parts.length !== 2) return res.status(401).json({ error: 'Định dạng token không hợp lệ' });

    const token = parts[1];
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (e) {
        res.status(401).json({ error: 'Phiên đăng nhập hết hạn hoặc không hợp lệ' });
    }
};

// ================= BỘ ĐÁP ÁN CỐ ĐỊNH =================
const KNOWN_ANSWERS = {
    "6ad6dcab51853efd08c71caf": "6ad6dc802cb1ab231450789e",
    "6ad6dd0d3e4ade9cab213d5a": "6ad6dd162cb1ab231450796e",
    "6ad6dce290604f2e57fc965c": "6ad6dcb22cb1ab23145078e3"
};

// ================= API AUTH & USER =================
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Nhập thiếu thông tin' });
        const exists = await User.findOne({ username });
        if (exists) return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại!' });

        const salt = await bcrypt.genSalt(10);
        const hashPass = await bcrypt.hash(password, salt);
        await User.create({ username, password: hashPass });
        res.json({ success: true, message: 'Tạo tài khoản thành công!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Nhập thiếu thông tin' });

        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ error: 'Tài khoản không tồn tại' });

        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(400).json({ error: 'Sai mật khẩu' });

        const token = jwt.sign(
            { _id: user._id, username: user.username, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );
        res.json({ token, role: user.role, username: user.username });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/me', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
        res.json({
            username: user.username,
            plan: user.plan,
            dailyUses: user.dailyUses,
            maxUses: LIMITS[user.plan] || 5
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/payment/request', auth, async (req, res) => {
    try {
        const { plan, amount } = req.body;
        await Payment.create({ username: req.user.username, plan, amount });
        res.json({ success: true, message: 'Đã gửi yêu cầu. Chờ Admin duyệt!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================= API QUÉT GAME =================
app.post('/api/scan', auth, async (req, res) => {
    let browser;
    try {
        const { pin } = req.body;
        if (!pin) return res.status(400).json({ error: 'Vui lòng nhập mã PIN' });

        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });

        const today = getToday();
        if (user.lastUsedDate !== today) {
            user.dailyUses = 0;
            user.lastUsedDate = today;
        }

        if (user.plan !== 'free' && user.planExpiry && user.planExpiry < new Date()) {
            user.plan = 'free';
        }

        if (user.dailyUses >= (LIMITS[user.plan] || 5)) {
            return res.status(403).json({ error: 'Đã hết lượt sử dụng hôm nay. Vui lòng nâng cấp!' });
        }

        console.log(`\n[+] ${user.username} đang quét PIN: ${pin}...`);

        const chromium = await getChromium();
        browser = await puppeteer.launch({
            args: puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
            defaultViewport: { width: 1280, height: 800 },
            executablePath: await chromium.executablePath(),
            headless: 'shell'
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        let roomData = null;
        let quizId = null;

        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('/play-api/v5/join') || url.includes('/_gameapi/')) {
                try {
                    const json = await response.json();
                    if (json && (json.room || json.data?.room)) {
                        const room = json.room || json.data?.room;
                        roomData = room.questions;
                        quizId = room.quizId || room.id;
                    }
                } catch (e) {}
            }
        });

        await page.goto('https://wayground.com', { waitUntil: 'networkidle2', timeout: 60000 });

        await page.waitForFunction(
            () => Array.from(document.querySelectorAll('input')).some(el => el.offsetParent !== null),
            { timeout: 15000 }
        );
        await page.evaluate((p) => {
            const input = Array.from(document.querySelectorAll('input')).find(el => el.offsetParent !== null);
            if (input) {
                input.focus();
                Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, p);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, pin);
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 3000));

        await page.evaluate(() => {
            const input = document.querySelector('[data-cy="enter-name-field"]');
            if (input) {
                input.focus();
                Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Player 1');
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        await new Promise(r => setTimeout(r, 1000));

        await page.evaluate(() => {
            const btn = document.querySelector('button[data-cy="start-game-button"]');
            if (btn) btn.click();
        });

        let waited = 0;
        while (!roomData && waited < 15000) {
            await new Promise(r => setTimeout(r, 500));
            waited += 500;
        }
        if (!roomData) {
            throw new Error('Không lấy được dữ liệu phòng. Hãy kiểm tra lại mã PIN của bạn.');
        }

        // Lấy dữ liệu quiz đầy đủ (nếu lỗi sẽ dùng roomData làm dự phòng)
        const rawQuizData = await page.evaluate(async (rId) => {
            try {
                const res = await fetch(`https://wayground.com/_quizserver/main/v2/quiz/${rId}`);
                if (!res.ok) return null;
                const data = await res.json();
                return data?.data?.quiz?.info?.questions || null;
            } catch (e) { return null; }
        }, quizId);

        await browser.close();
        browser = null;

        const questionsObj = rawQuizData || roomData;

        const questionsToAsk = [];
        const finalAnswers = {};

        for (const [id, q] of Object.entries(questionsObj)) {
            if (q.type === 'COMPREHENSION') continue;

            if (KNOWN_ANSWERS[id]) {
                finalAnswers[id] = KNOWN_ANSWERS[id];
            } else if (q.structure?.options?.length > 0) {
                questionsToAsk.push({
                    id,
                    type: q.type,
                    question: q.structure.query?.text,
                    options: q.structure.options.map(o => ({ id: o.id, text: o.text }))
                });
            }
        }

        if (questionsToAsk.length > 0) {
            try {
                const payload = {
                    contents: [{ parts: [{ text: JSON.stringify(questionsToAsk) }] }],
                    systemInstruction: {
                        parts: [{
                            text: `Bạn là một trợ lý học tập chuyên môn cao về chương trình sách giáo khoa lớp 11 tại Việt Nam. Tôi gửi kèm đây một tệp JSON chứa các câu hỏi trắc nghiệm ôn tập.
Hãy thực hiện các yêu cầu sau một cách thầm lặng:
1. Đọc và phân tích kỹ nội dung từng câu hỏi trong tệp JSON.
2. Đối chiếu câu hỏi và các đáp án với chuẩn kiến thức trong chương trình SGK lớp 11.
3. Chọn đáp án đúng nhất cho từng câu.
LƯU Ý QUAN TRỌNG: Bạn BẮT BUỘC phải trả về ĐÚNG MỘT chuỗi JSON duy nhất theo cấu trúc sau (KHÔNG kèm lời giải thích, KHÔNG markdown):
{"answers": {"<id_câu_hỏi>": "<id_đáp_án_đúng>"}}`
                        }]
                    },
                    generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
                };

                const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
                const aiRes = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    }
                );
                const aiData = await aiRes.json();

                const text = aiData.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                    const clean = text.replace(/```json|```/g, '').trim();
                    const aiAnswers = JSON.parse(clean).answers || {};
                    Object.assign(finalAnswers, aiAnswers);
                } else {
                    console.error('Gemini không trả về nội dung:', JSON.stringify(aiData).slice(0, 500));
                }
            } catch (e) {
                console.error('Lỗi kết nối Gemini AI:', e);
            }
        }

        for (const [id, q] of Object.entries(questionsObj)) {
            if (!q.structure) continue;
            const ansId = finalAnswers[id];
            if (ansId) {
                const opt = (q.structure.options || []).find(o => o.id === ansId);
                q.structure.correctAnswers = opt ? [opt] : [{ text: ansId }];
            } else {
                q.structure.correctAnswers = [];
            }
        }

        user.dailyUses += 1;
        await user.save();

        res.json({ success: true, questions: Object.values(questionsObj) });
    } catch (error) {
        console.error('Lỗi /api/scan:', error.message);
        res.status(500).json({ error: error.message });
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
    }
});

// ================= API SPAWN BOT =================
app.post('/api/spawn', auth, (req, res) => {
    res.status(400).json({
        error: 'Chức năng Spawn Bot chạy ngầm không được hỗ trợ trên Vercel Serverless. Hãy chuyển sang VPS hoặc Koyeb nếu cần chạy bot liên tục.'
    });
});

// ================= API ADMIN =================
const adminAuth = async (req, res, next) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Không có quyền truy cập' });
        next();
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

app.get('/api/admin/users', auth, adminAuth, async (req, res) => {
    try {
        const users = await User.find({}, '-password');
        res.json(users);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/payments', auth, adminAuth, async (req, res) => {
    try {
        const payments = await Payment.find({ status: 'pending' });
        res.json(payments);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/approve', auth, adminAuth, async (req, res) => {
    try {
        const { paymentId } = req.body;
        const payment = await Payment.findById(paymentId);
        if (!payment) return res.status(404).json({ error: 'Không tìm thấy hóa đơn' });

        payment.status = 'approved';
        await payment.save();

        const user = await User.findOne({ username: payment.username });
        if (user) {
            user.plan = payment.plan;
            user.dailyUses = 0;
            const expiry = new Date();
            expiry.setMonth(expiry.getMonth() + 1);
            user.planExpiry = expiry;
            await user.save();
        }
        res.json({ success: true, message: 'Đã phê duyệt nâng cấp thành công!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================= KHỞI ĐỘNG =================
const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`🚀 Server đang vận hành trên port: ${PORT}`);
    });
}

// Vercel cần export app
module.exports = app;
