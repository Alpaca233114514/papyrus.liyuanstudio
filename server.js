require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const PORT = process.env.PORT || 3000;
const DAILY_QUOTA = 50_000; // 50K tokens per IP per day

if (!DEEPSEEK_API_KEY) {
  console.error('Missing DEEPSEEK_API_KEY in .env');
  process.exit(1);
}

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// In-memory token usage tracker: { "ip": { date: "2026-04-27", tokens: 12345 } }
const usageMap = new Map();

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function getUsage(ip) {
  const record = usageMap.get(ip);
  const today = getToday();
  if (!record || record.date !== today) {
    const fresh = { date: today, tokens: 0 };
    usageMap.set(ip, fresh);
    return fresh;
  }
  return record;
}

function addUsage(ip, tokens) {
  const record = getUsage(ip);
  record.tokens += tokens;
}

// Clean stale entries every hour
setInterval(() => {
  const today = getToday();
  for (const [ip, record] of usageMap) {
    if (record.date !== today) usageMap.delete(ip);
  }
}, 3600_000).unref();

// GET /v1/models — connection test endpoint
app.get('/v1/models', async (_req, res) => {
  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/models`, {
      headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    });
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: `DeepSeek unreachable: ${e.message}` });
  }
});

// POST /v1/chat/completions — stream proxy with quota
app.post('/v1/chat/completions', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const usage = getUsage(ip);

  if (usage.tokens >= DAILY_QUOTA) {
    res.status(429).json({
      error: {
        message: `今日免费额度已用完 (${DAILY_QUOTA.toLocaleString()} tokens/天)。请明天再试，或升级到付费计划。`,
        type: 'quota_exceeded',
        quota: DAILY_QUOTA,
        used: usage.tokens,
      },
    });
    return;
  }

  const isStream = req.body.stream === true;

  try {
    const upstreamResp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(req.body),
    });

    if (!upstreamResp.ok) {
      const errText = await upstreamResp.text().catch(() => '');
      res.status(upstreamResp.status).send(errText);
      return;
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let totalTokens = 0;
      const reader = upstreamResp.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          res.write(chunk);

          // Extract usage from the final SSE chunk (contains [DONE] or usage info)
          for (const line of chunk.split('\n')) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const json = JSON.parse(line.slice(6));
                if (json.usage?.total_tokens) {
                  totalTokens = json.usage.total_tokens;
                }
              } catch {}
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      addUsage(ip, totalTokens);
      res.end();
    } else {
      // Non-streaming
      const data = await upstreamResp.json();
      const tokens = data.usage?.total_tokens || 0;
      addUsage(ip, tokens);
      res.json(data);
    }
  } catch (e) {
    res.status(502).json({ error: `DeepSeek unreachable: ${e.message}` });
  }
});

// GET /v1/usage — check current usage (for debugging / UI)
app.get('/v1/usage', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const usage = getUsage(ip);
  res.json({ ip, date: usage.date, tokens_used: usage.tokens, daily_quota: DAILY_QUOTA });
});

// Serve static landing page for all other routes
app.use(express.static(path.join(__dirname), { index: 'index.html' }));

app.listen(PORT, () => {
  console.log(`Papyrus LiYuan DeepSeek Proxy running on port ${PORT}`);
  console.log(`Daily quota: ${DAILY_QUOTA.toLocaleString()} tokens per IP`);
});
