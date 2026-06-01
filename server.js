const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));
app.use(express.json());

// ── Load API key ──────────────────────────────────────────
// Always prefer environment variable (Render sets this directly)
let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
// Fallback: try reading .env file (for local development)
if (!ANTHROPIC_API_KEY) {
  try {
    const env = fs.readFileSync('.env', 'utf8');
    const m = env.match(/ANTHROPIC_API_KEY=(.+)/);
    if (m) ANTHROPIC_API_KEY = m[1].trim();
  } catch (_) {}
}
console.log('API Key check — length:', ANTHROPIC_API_KEY.length, '| starts with sk-ant:', ANTHROPIC_API_KEY.startsWith('sk-ant'));

// ── In-memory game state ──────────────────────────────────
const rooms = {};

function makeCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomForSocket(socketId) {
  return Object.values(rooms).find(r => r.players.some(p => p.id === socketId));
}

// ── AI Question Generator ─────────────────────────────────
async function generateQuestions(type, topic, difficulty, count, usedQuestions) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const diffDesc = {
    easy:   'easy, suitable for general knowledge beginners',
    medium: 'moderate difficulty, requiring some knowledge',
    hard:   'challenging, requiring good domain knowledge',
    expert: 'expert-level, very specific and difficult',
  }[difficulty] || 'moderate difficulty';

  const avoidLine = (usedQuestions || []).length
    ? `Do NOT repeat these questions: ${usedQuestions.slice(-20).join(' | ')}`
    : '';

  let prompt = '';
  if (type === 'mcq') {
    prompt = `Generate ${count} unique multiple-choice quiz questions that are ${diffDesc}.
Topic: General Knowledge (mix of science, history, geography, pop culture, sports).
${avoidLine}
Return ONLY a JSON array, no markdown, exactly this format:
[{"question":"...?","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A) ...","explanation":"..."}]`;
  } else if (type === 'topic') {
    prompt = `Generate 15 unique multiple-choice questions about "${topic}" that are ${diffDesc}.
${avoidLine}
Return ONLY a JSON array, no markdown, exactly this format:
[{"question":"...?","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A) ...","explanation":"..."}]`;
  } else if (type === 'puzzle') {
    prompt = `Generate ${count} unique logic puzzles or lateral thinking brain teasers that are ${diffDesc}.
These must be riddles or logical reasoning problems, NOT general knowledge MCQs.
${avoidLine}
Return ONLY a JSON array, no markdown, exactly this format:
[{"question":"...?","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A) ...","explanation":"..."}]`;
  }

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

// ── Helpers ───────────────────────────────────────────────
function getLobbyData(code) {
  const r = rooms[code];
  return {
    code,
    players: r.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, team: p.team })),
    difficulty: r.difficulty,
    mode: r.mode,
    host: r.host,
  };
}

function getScores(code) {
  return rooms[code].players
    .map(p => ({ id: p.id, name: p.name, score: p.score, team: p.team }))
    .sort((a, b) => b.score - a.score);
}

function getRound1Winner(room) {
  return [...room.players].sort((a, b) => b.score - a.score)[0];
}

function sendQuestion(code) {
  const room = rooms[code];
  if (!room) return;
  const questions = room.quiz.currentRound === 1
    ? room.quiz.round1Questions
    : room.quiz.round3Questions;
  const qi = room.quiz.currentQ;
  if (qi >= questions.length) {
    if (room.quiz.currentRound === 1) endRound1(code);
    else endRound3(code);
    return;
  }
  const q = questions[qi];
  io.to(code).emit('question', {
    round: room.quiz.currentRound,
    questionIndex: qi,
    total: questions.length,
    question: q.question,
    options: q.options,
  });
}

function sendRound2Question(code, playerId) {
  const room = rooms[code];
  if (!room) return;
  const player = room.players.find(p => p.id === playerId);
  if (!player) return;

  const qi = player.round2QIndex || 0;
  const q  = room.quiz.round2Questions[qi];
  const timeLeft = Math.max(0, 60 - Math.floor((Date.now() - room.quiz.round2Timer) / 1000));

  if (!q || timeLeft <= 0) return; // no more questions or time up

  // Send only to this specific player
  io.to(playerId).emit('round2_question', {
    questionIndex: qi,
    total: room.quiz.round2Questions.length,
    question: q.question,
    options: q.options,
    timeLeft,
  });
}

// Send first round2 question to ALL players simultaneously
function sendRound2QuestionToAll(code) {
  const room = rooms[code];
  if (!room) return;
  room.players.forEach(p => {
    p.round2QIndex = 0;
    sendRound2Question(code, p.id);
  });
}

function revealAndAdvance(code, questionIndex, playerId) {
  const room = rooms[code];
  if (!room) return;

  if (room.state === 'round2') {
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    const qi  = player.round2QIndex || 0;
    const q   = room.quiz.round2Questions[qi];
    const key = 'round2_' + playerId + '_' + qi;
    const ans = room.quiz.answered[key] || {};

    // Send reveal only to this player
    io.to(playerId).emit('question_reveal', {
      questionIndex: qi,
      correctAnswer: q.answer,
      explanation:   q.explanation,
      scores:        getScores(code),
      firstCorrect:  ans.firstCorrect || null,
      isRound2:      true,
    });

    // Also broadcast updated scores to everyone
    io.to(code).emit('scores_update', getScores(code));

    setTimeout(function() {
      if (!rooms[code] || rooms[code].state !== 'round2') return;
      const elapsed = Date.now() - room.quiz.round2Timer;
      if (elapsed >= 60000) return; // timer ended, endRound2 already called
      player.round2QIndex = (player.round2QIndex || 0) + 1;
      if (player.round2QIndex >= room.quiz.round2Questions.length) {
        // This player exhausted all questions — show waiting message
        io.to(playerId).emit('round2_waiting', { message: 'You answered all questions! Wait for the round to end.' });
      } else {
        sendRound2Question(code, playerId);
      }
    }, 3000);
    return;
  }

  const questions = room.state === 'round1'
    ? room.quiz.round1Questions
    : room.quiz.round3Questions;
  const q   = questions[questionIndex];
  const key = room.state + '_' + questionIndex;
  const ans = room.quiz.answered[key] || {};
  io.to(code).emit('question_reveal', {
    questionIndex,
    correctAnswer: q.answer,
    explanation:   q.explanation,
    scores:        getScores(code),
    firstCorrect:  ans.firstCorrect || null,
  });
  setTimeout(function() { room.quiz.currentQ++; sendQuestion(code); }, 4000);
}

function endRound1(code) {
  const room = rooms[code];
  if (!room) return;
  room.state = 'topic_select';
  const winner = getRound1Winner(room);
  const topics = [
    'Science & Technology','History','Movies & Cinema',
    'Video Games','Sitcoms & TV Shows','Sports',
    'Geography','Music','Literature',
    'Food & Cuisine','Mythology','Space & Astronomy',
  ];
  io.to(code).emit('round1_end', {
    scores:   getScores(code),
    winner:   winner.name,
    winnerId: winner.id,
    topics,
    message: `Round 1 over! ${winner.name} leads with ${winner.score} points and picks the topic for Round 2!`,
  });
}

function endRound2(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.round2Timeout) { clearTimeout(room.round2Timeout); room.round2Timeout = null; }
  room.state = 'round3';
  room.quiz.currentQ = 0;
  room.quiz.currentRound = 3;
  io.to(code).emit('round_start', {
    round: 3,
    title: 'Round 3: Puzzles & Logic',
    instructions: '5 brain teasers and logic puzzles! First correct answer = full points, others = half. Think fast but think smart!',
    totalQuestions: 5,
  });
  setTimeout(() => sendQuestion(code), 4000);
}

function endRound3(code) {
  const room = rooms[code];
  if (!room) return;
  room.state = 'final';
  const scores = getScores(code);
  let teamScores = null;
  if (room.mode === 'teams') {
    const teams = {};
    room.players.forEach(p => {
      const t = p.team || 'No Team';
      if (!teams[t]) teams[t] = { name: t, score: 0, members: [] };
      teams[t].score += p.score;
      teams[t].members.push(p.name);
    });
    teamScores = Object.values(teams).sort((a, b) => b.score - a.score);
  }
  io.to(code).emit('game_over', {
    scores,
    teamScores,
    winner:      scores[0].name,
    winnerScore: scores[0].score,
    mode:        room.mode,
  });
  setTimeout(() => { delete rooms[code]; }, 600000);
}

// ── Socket events ─────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('create_room', ({ name, difficulty, mode }) => {
    let code;
    do { code = makeCode(); } while (rooms[code]);
    const player = { id: socket.id, name, score: 0, isHost: true };
    rooms[code] = {
      code, host: socket.id, difficulty, mode,
      players: [player], state: 'lobby',
      quiz: {
        round1Questions: [], round2Questions: [], round3Questions: [],
        currentQ: 0, currentRound: 0, round2Topic: null,
        round2QIndex: 0, answered: {}, round2Timer: null,
      },
      usedQuestions: [],
    };
    socket.join(code);
    socket.emit('room_created', { code, player });
    io.to(code).emit('lobby_update', getLobbyData(code));
  });

  socket.on('join_room', ({ name, code }) => {
    const room = rooms[code];
    if (!room)                    { socket.emit('error', 'Room not found. Check your code.'); return; }
    if (room.state !== 'lobby')   { socket.emit('error', 'Game already started.'); return; }
    if (room.players.length >= 10){ socket.emit('error', 'Room is full (max 10).'); return; }
    const player = { id: socket.id, name, score: 0, isHost: false };
    room.players.push(player);
    socket.join(code);
    socket.emit('room_joined', { code, player });
    io.to(code).emit('lobby_update', getLobbyData(code));
  });

  socket.on('set_team', ({ code, teamName }) => {
    const room = rooms[code]; if (!room) return;
    const p = room.players.find(p => p.id === socket.id); if (!p) return;
    p.team = teamName;
    io.to(code).emit('lobby_update', getLobbyData(code));
  });

  socket.on('start_game', async ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    if (room.players.length < 2) { socket.emit('error', 'Need at least 2 players.'); return; }

    room.state = 'loading';
    io.to(code).emit('game_loading', { message: 'AI is generating your quiz questions...' });

    try {
      const [r1, r3] = await Promise.all([
        generateQuestions('mcq',    null, room.difficulty, 5, room.usedQuestions),
        generateQuestions('puzzle', null, room.difficulty, 5, room.usedQuestions),
      ]);
      room.quiz.round1Questions = r1;
      room.quiz.round3Questions = r3;
      room.usedQuestions.push(...r1.map(q => q.question), ...r3.map(q => q.question));
      room.state = 'round1';
      room.quiz.currentQ = 0;
      room.quiz.currentRound = 1;
      io.to(code).emit('round_start', {
        round: 1,
        title: 'Round 1: Speed Quiz',
        instructions: '5 multiple-choice questions shown to everyone at the same time. First correct answer = FULL points. Everyone else correct = HALF points. No time limit — faster is better!',
        totalQuestions: 5,
      });
      setTimeout(() => sendQuestion(code), 4000);
    } catch (err) {
      console.error('Question generation failed — full error:', JSON.stringify(err.message), 'Status:', err.status);
      const msg = err.message.includes('401') || err.message.includes('auth') ? 'Invalid API key — check Render environment variables.' : err.message.includes('credit') || err.message.includes('billing') || err.message.includes('quota') ? 'No Anthropic credits — add billing at console.anthropic.com' : err.message.includes('overload') ? 'Anthropic busy — try again in 30 seconds.' : 'Question generation failed: ' + err.message; io.to(code).emit('error', msg);
      room.state = 'lobby';
    }
  });

  socket.on('submit_answer', ({ code, answer, questionIndex }) => {
    const room = rooms[code]; if (!room) return;
    const player = room.players.find(p => p.id === socket.id); if (!player) return;

    let questions;
    if      (room.state === 'round1') questions = room.quiz.round1Questions;
    else if (room.state === 'round2') questions = room.quiz.round2Questions;
    else if (room.state === 'round3') questions = room.quiz.round3Questions;
    else return;

    const q   = questions[questionIndex]; if (!q) return;

    // Round 2: each player has their own key so they answer independently
    const key = room.state === 'round2'
      ? 'round2_' + socket.id + '_' + questionIndex
      : room.state + '_' + questionIndex;

    if (!room.quiz.answered[key]) room.quiz.answered[key] = { firstCorrect: null, responders: [] };
    if (room.quiz.answered[key].responders.find(r => r.id === socket.id)) return;

    const isCorrect = answer === q.answer;
    const isFirst   = isCorrect && room.quiz.answered[key].firstCorrect === null;
    const base      = { easy:100, medium:200, hard:350, expert:500 }[room.difficulty] || 200;

    // Round 2: full points for correct, 0 for wrong (no half points — independent flow)
    const pts = room.state === 'round2'
      ? (isCorrect ? base : 0)
      : (isCorrect ? (isFirst ? base : Math.floor(base / 2)) : 0);

    player.score += pts;
    if (isFirst) room.quiz.answered[key].firstCorrect = { id: socket.id, name: player.name };
    room.quiz.answered[key].responders.push({ id: socket.id, correct: isCorrect });

    socket.emit('answer_result', {
      correct: isCorrect, isFirst, pointsEarned: pts,
      correctAnswer: q.answer, explanation: q.explanation, questionIndex,
    });
    io.to(code).emit('scores_update', getScores(code));

    if (room.state === 'round2') {
      // Each player advances independently after answering (correct or wrong)
      revealAndAdvance(code, questionIndex, socket.id);
    } else {
      // Round 1 and 3: advance when all players answered
      if (room.quiz.answered[key].responders.length === room.players.length) {
        revealAndAdvance(code, questionIndex);
      }
    }
  });

  socket.on('round2_skip', ({ code }) => {
    const room = rooms[code];
    if (!room || room.state !== 'round2') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    // Check time
    const elapsed = Date.now() - room.quiz.round2Timer;
    if (elapsed >= 60000) return;

    // Move THIS player to next question
    player.round2QIndex = (player.round2QIndex || 0) + 1;
    if (player.round2QIndex >= room.quiz.round2Questions.length) {
      io.to(socket.id).emit('round2_waiting', { message: 'You answered all questions! Wait for the round to end.' });
    } else {
      sendRound2Question(code, socket.id);
    }
  });

  socket.on('select_topic', async ({ code, topic }) => {
    const room = rooms[code]; if (!room) return;
    const winner = getRound1Winner(room);
    if (socket.id !== winner.id) { socket.emit('error', 'Only the Round 1 winner can pick!'); return; }

    io.to(code).emit('game_loading', { message: `Loading ${topic} questions...` });
    try {
      const questions = await generateQuestions('topic', topic, room.difficulty, 15, room.usedQuestions);
      // Cancel any previous round2 timeout
      if (room.round2Timeout) { clearTimeout(room.round2Timeout); room.round2Timeout = null; }
      room.quiz.round2Questions = questions;
      room.quiz.round2Topic     = topic;
      room.quiz.round2QIndex    = 0;
      room.quiz.answered        = Object.fromEntries(
        Object.entries(room.quiz.answered).filter(([k]) => !k.startsWith('round2'))
      );
      room.usedQuestions.push(...questions.map(q => q.question));
      room.state = 'round2';
      io.to(code).emit('round_start', {
        round: 2,
        title: `Round 2: ${topic} Sprint`,
        instructions: `60-second free-for-all on ${topic}! One question at a time — everyone races to answer. First correct = full points, rest = half. Host can skip any question!`,
        totalQuestions: questions.length,
        topic,
        timeLimit: 60,
      });
      setTimeout(() => {
        room.quiz.round2Timer = Date.now();
        sendRound2QuestionToAll(code);
        room.round2Timeout = setTimeout(() => endRound2(code), 60000);
      }, 3500);
    } catch (err) {
      console.error('Topic questions failed:', err.message);
      io.to(code).emit('error', 'Failed to load topic questions.');
    }
  });

  socket.on('disconnect', () => {
    const room = getRoomForSocket(socket.id);
    if (!room) return;
    const leaving = room.players.find(p => p.id === socket.id);
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) { delete rooms[room.code]; return; }
    if (room.host === socket.id) {
      room.host = room.players[0].id;
      room.players[0].isHost = true;
    }
    io.to(room.code).emit('lobby_update', getLobbyData(room.code));
    if (leaving) io.to(room.code).emit('player_left', { name: leaving.name });
  });
});

// ── Start server ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', function () {
  console.log('\n🧠 Quiz App running!');
  console.log('   Open: http://localhost:' + PORT);
  console.log('   Also try: http://127.0.0.1:' + PORT);
  console.log('   API Key: ' + (ANTHROPIC_API_KEY ? '✅ Loaded' : '❌ Missing — add to .env') + '\n');
});

server.on('error', function (err) {
  if (err.code === 'EADDRINUSE') {
    console.error('❌ Port ' + PORT + ' is busy. Try changing PORT in server.js to 3001');
  } else {
    console.error('❌ Server error:', err.message);
  }
  process.exit(1);
});

process.on('uncaughtException', function (err) {
  console.error('❌ Crash:', err.message);
});
