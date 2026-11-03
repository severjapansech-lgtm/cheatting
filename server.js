const express = require('express');
const mongoose = require('mongoose');
const puppeteer = require('puppeteer');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => res.redirect('/login.html'));

// ================= KẾT NỐI MONGODB =================
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Đã kết nối MongoDB'))
    .catch(err => console.error('❌ Lỗi kết nối MongoDB (Bạn đã bật MongoDB chưa?):', err.message));

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    role: { type: String, default: 'user' },
    plan: { type: String, default: 'free' },
    dailyUses: { type: Number, default: 0 },
    lastUsedDate: { type: String, default: '' },
    planExpiry: { type: Date, default: null }
});
const User = mongoose.model('User', UserSchema);

const PaymentSchema = new mongoose.Schema({
    username: String,
    plan: String,
    amount: Number,
    status: { type: String, default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});
const Payment = mongoose.model('Payment', PaymentSchema);

// Tự động tạo Admin
async function initAdmin() {
    const admin = await User.findOne({ username: 'bindev' });
    if (!admin) {
        const salt = await bcrypt.genSalt(10);
        const hashPass = await bcrypt.hash('DOBAONGOC01032010@', salt);
        await User.create({ username: 'bindev', password: hashPass, role: 'admin' });
        console.log('👑 Đã tạo tài khoản Admin: bindev / DOBAONGOC01032010@');
    }
}
initAdmin();

const getToday = () => new Date().toISOString().split('T')[0];

const auth = (req, res, next) => {
    const token = req.header('Authorization')?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Vui lòng đăng nhập' });
    try {
        const verified = jwt.verify(token, process.env.JWT_SECRET);
        req.user = verified;
        next();
    } catch (e) { res.status(401).json({ error: 'Phiên đăng nhập hết hạn' }); }
};

// ================= CẤU HÌNH CHROME =================
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// ================= BỘ ĐÁP ÁN ĐÃ SỬA (CHỐNG SAI 100%) =================
const KNOWN_ANSWERS = {
    "6ad6dcab51853efd08c71caf": "6ad6dc802cb1ab231450789e", // Loại phần mềm -> B
    "6ad6dd0d3e4ade9cab213d5a": "6ad6dd162cb1ab231450796e", // Quyền chỉnh sửa -> C
    "6ad6dce290604f2e57fc965c": "6ad6dcb22cb1ab23145078e3"  // Lưu trữ trực tuyến -> C
};

// ================= API AUTH & USER =================
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Nhập thiếu thông tin' });
    const exists = await User.findOne({ username });
    if (exists) return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại!' });

    const salt = await bcrypt.genSalt(10);
    const hashPass = await bcrypt.hash(password, salt);
    await User.create({ username, password: hashPass });
    res.json({ success: true, message: 'Tạo tài khoản thành công!' });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ error: 'Tài khoản không tồn tại' });
    
    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) return res.status(400).json({ error: 'Sai mật khẩu' });
    
    const token = jwt.sign({ _id: user._id, username: user.username, role: user.role }, process.env.JWT_SECRET);
    res.json({ token, role: user.role, username: user.username });
});

app.get('/api/me', auth, async (req, res) => {
    const user = await User.findById(req.user._id);
    const limits = { free: 5, '50k': 15, '100k': 30, '200k': 999999 };
    res.json({
        username: user.username,
        plan: user.plan,
        dailyUses: user.dailyUses,
        maxUses: limits[user.plan]
    });
});

app.post('/api/payment/request', auth, async (req, res) => {
    const { plan, amount } = req.body;
    await Payment.create({ username: req.user.username, plan, amount });
    res.json({ success: true, message: 'Đã gửi yêu cầu. Chờ Admin duyệt!' });
});

// ================= API QUÉT GAME =================
app.post('/api/scan', auth, async (req, res) => {
    const { pin } = req.body;
    const user = await User.findById(req.user._id);
    
    const today = getToday();
    if (user.lastUsedDate !== today) {
        user.dailyUses = 0;
        user.lastUsedDate = today;
    }
    
    const limits = { free: 5, '50k': 15, '100k': 30, '200k': 999999 };
    if (user.plan !== '200k' && user.planExpiry && user.planExpiry < new Date()) user.plan = 'free';
    
    if (user.dailyUses >= limits[user.plan]) {
        return res.status(403).json({ error: 'Đã hết lượt sử dụng hôm nay. Vui lòng nâng cấp!' });
    }

    console.log(`\n[+] ${user.username} đang quét PIN: ${pin}...`);
    let browser;
    try {
        browser = await puppeteer.launch({ 
            headless: false, 
            executablePath: CHROME_PATH, 
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
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

        await page.goto('https://wayground.com/join', { waitUntil: 'networkidle2', timeout: 60000 });
        
        await page.waitForFunction(() => Array.from(document.querySelectorAll('input')).some(el => el.offsetParent !== null), { timeout: 15000 });
        await page.evaluate((p) => {
            const input = Array.from(document.querySelectorAll('input')).find(el => el.offsetParent !== null);
            if (input) {
                input.focus();
                Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, p);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, pin);
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 3000));

        await page.evaluate(() => {
            let input = document.querySelector('[data-cy="enter-name-field"]');
            if (input) {
                input.focus();
                Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, 'Player 1');
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        await new Promise(r => setTimeout(r, 1000));

        await page.evaluate(() => {
            let btn = document.querySelector('button[data-cy="start-game-button"]');
            if (btn) btn.click();
        });

        let waited = 0;
        while (!roomData && waited < 15000) {
            await new Promise(r => setTimeout(r, 500));
            waited += 500;
        }
        if (!roomData) {
            await page.screenshot({ path: 'error_screenshot.png' });
            throw new Error('Không lấy được dữ liệu phòng. Xem error_screenshot.png.');
        }

        const rawQuizData = await page.evaluate(async (rId) => {
            try {
                const res = await fetch(`https://wayground.com/api/main/quiz/${rId}`);
                if (!res.ok) return null;
                const data = await res.json();
                return data?.data?.quiz?.info?.questions;
            } catch (e) { return null; }
        }, quizId);

        await browser.close();
        const questionsObj = rawQuizData || roomData;

        let questionsToAsk = [];
        let finalAnswers = {};

        for (const [id, q] of Object.entries(questionsObj)) {
            if (q.type === 'COMPREHENSION') continue;

            if (KNOWN_ANSWERS[id]) {
                finalAnswers[id] = KNOWN_ANSWERS[id]; 
            } else if (q.structure.options?.length > 0) {
                questionsToAsk.push({ 
                    id, 
                    type: q.type, 
                    question: q.structure.query.text, 
                    options: q.structure.options.map(o => ({id: o.id, text: o.text})) 
                });
            }
        }

        if (questionsToAsk.length > 0) {
            try {
                const payload = {
                    contents: [{ parts: [{ text: JSON.stringify(questionsToAsk) }] }],
                    // TÍCH HỢP PROMPT CỦA BẠN
                    systemInstruction: { 
                        parts: [{ 
                            text: `Bạn là một trợ lý học tập chuyên môn cao về chương trình sách giáo khoa lớp 11 tại Việt Nam. Tôi gửi kèm đây một tệp JSON chứa các câu hỏi trắc nghiệm ôn tập.

Hãy thực hiện các yêu cầu sau một cách thầm lặng:
1. Đọc và phân tích kỹ nội dung từng câu hỏi trong tệp JSON.
2. Đối chiếu câu hỏi và các đáp án với chuẩn kiến thức trong chương trình SGK lớp 11 (ưu tiên bám sát nội dung Tin học 11 và các môn học liên quan).
3. Kiểm tra tính chính xác của đáp án hiện tại. Nếu phát hiện câu nào có đáp án sai hoặc chưa tối ưu, hãy tự động chỉnh sửa lại cho đúng.

LƯU Ý QUAN TRỌNG: Vì tôi đang sử dụng API tự động, bạn BẮT BUỘC phải trả về ĐÚNG MỘT chuỗi JSON duy nhất theo cấu trúc sau (KHÔNG kèm lời giải thích, KHÔNG markdown):
{"answers": {"<questionId>": "<optionId>"}}` 
                        }] 
                    },
                    generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
                };
                
                const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const aiData = await aiRes.json();
                
                if (aiData.candidates?.[0]?.content?.parts?.[0]?.text) {
                    const aiAnswers = JSON.parse(aiData.candidates[0].content.parts[0].text).answers || {};
                    Object.assign(finalAnswers, aiAnswers); 
                }
            } catch (e) { console.error('Lỗi AI:', e); }
        }

        for (const [id, q] of Object.entries(questionsObj)) {
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
        if (browser) await browser.close();
        res.status(500).json({ error: error.message });
    }
});

// ================= API SPAWN BOT =================
const activeBrowsers = []; 

app.post('/api/spawn', auth, async (req, res) => {
    const { pin, count, prefix } = req.body;
    
    if (!pin || !count || count <= 0) return res.status(400).json({ error: 'Vui lòng nhập PIN và Số lượng hợp lệ' });
    if (count > 10) return res.status(400).json({ error: 'Để tránh treo máy chủ, mỗi lần chỉ được tạo tối đa 10 bot!' });

    console.log(`\n[+] ${req.user.username} đang tạo ${count} bot cho PIN: ${pin}...`);
    res.json({ success: true, message: `Đang tiến hành tạo ${count} bot. Quá trình chạy ngầm đang diễn ra...` });

    try {
        const browser = await puppeteer.launch({ 
            headless: "new", 
            executablePath: CHROME_PATH, 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--blink-settings=imagesEnabled=false'
            ] 
        });
        activeBrowsers.push(browser);

        const spawnSingleBot = async (botIndex) => {
            try {
                const context = await browser.createBrowserContext();
                const page = await context.newPage();
                
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    const type = req.resourceType();
                    if (type === 'image' || type === 'stylesheet' || type === 'font' || type === 'media') {
                        req.abort();
                    } else {
                        req.continue();
                    }
                });

                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                
                await page.goto('https://wayground.com/join', { waitUntil: 'domcontentloaded', timeout: 60000 });
                
                await page.waitForFunction(() => Array.from(document.querySelectorAll('input')).some(el => el.offsetParent !== null), { timeout: 15000 });
                await page.evaluate((p) => {
                    const input = Array.from(document.querySelectorAll('input')).find(el => el.offsetParent !== null);
                    if (input) {
                        input.focus();
                        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, p);
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }, pin);
                await page.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 2000));

                const botName = `${prefix || 'Bot'} ${botIndex}`;
                await page.evaluate((name) => {
                    let input = document.querySelector('[data-cy="enter-name-field"]');
                    if (input) {
                        input.focus();
                        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, name);
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }, botName);
                await new Promise(r => setTimeout(r, 500));

                await page.evaluate(() => {
                    let btn = document.querySelector('button[data-cy="start-game-button"]');
                    if (btn) btn.click();
                });

                await new Promise(r => setTimeout(r, 3000));
                const isError = await page.evaluate(() => {
                    const bodyText = document.body.innerText.toLowerCase();
                    return bodyText.includes('game not found') || bodyText.includes('full') || bodyText.includes('error');
                });

                if (!isError) {
                    console.log(`   [🤖] Đã cho bot "${botName}" vào phòng thành công!`);
                } else {
                    console.log(`   [❌] Bot "${botName}" thất bại! (Sai PIN, phòng full, hoặc bị chặn IP)`);
                }

            } catch (err) {
                console.error(`   [❌] Lỗi khi tạo bot thứ ${botIndex}:`, err.message);
            }
        };

        for (let i = 1; i <= count; i++) {
            await spawnSingleBot(i);
            await new Promise(r => setTimeout(r, 1500)); 
        }
        console.log(`[✅] Đã hoàn tất việc tạo ${count} bot!`);

    } catch (error) {
        console.error('[-] Lỗi khởi tạo trình duyệt cho Bot:', error.message);
    }
});

// ================= API ADMIN =================
const adminAuth = async (req, res, next) => {
    const user = await User.findById(req.user._id);
    if (user.role !== 'admin') return res.status(403).json({ error: 'Không có quyền' });
    next();
};

app.get('/api/admin/users', auth, adminAuth, async (req, res) => {
    const users = await User.find({}, '-password');
    res.json(users);
});

app.get('/api/admin/payments', auth, adminAuth, async (req, res) => {
    const payments = await Payment.find({ status: 'pending' });
    res.json(payments);
});

app.post('/api/admin/approve', auth, adminAuth, async (req, res) => {
    const { paymentId } = req.body;
    const payment = await Payment.findById(paymentId);
    if (!payment) return res.status(404).json({ error: 'Không tìm thấy đơn' });

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
    res.json({ success: true, message: 'Đã duyệt!' });
});

app.listen(process.env.PORT, () => {
    console.log(`🚀 Server chạy tại http://localhost:${process.env.PORT}`);
});