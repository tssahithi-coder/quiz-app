/* ═══════════════════════════════════════════════════════
   QuizBlitz — app.js
   All client-side logic: socket events, UI rendering
═══════════════════════════════════════════════════════ */

const socket = io();

// ── CLIENT STATE ─────────────────────────────────────
const state = {
  playerName: '',
  roomCode: '',
  playerId: '',
  isHost: false,
  difficulty: 'medium',
  mode: 'individual',
  currentQuestion: null,
  hasAnswered: false,
  round2Timer: null,
  round2StartTime: null,
  round2Duration: 60,
  introCountdown: null,
};

// ── SCREEN MANAGEMENT ────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function $(id) { return document.getElementById(id); }

// ── LOGIN ────────────────────────────────────────────
function goToMenu() {
  const name = $('player-name').value.trim();
  if (!name) { showError('login-error', 'Please enter your name!'); return; }
  if (name.length < 2) { showError('login-error', 'Name must be at least 2 characters.'); return; }
  state.playerName = name;
  $('menu-greeting').textContent = `Hi, ${name}! 👋`;
  hideError('login-error');
  showScreen('screen-menu');
}

$('player-name').addEventListener('keydown', e => { if (e.key === 'Enter') goToMenu(); });

// ── DIFFICULTY & MODE BUTTONS ────────────────────────
document.querySelectorAll('.diff-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.difficulty = btn.dataset.diff;
  });
});

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
  });
});

// ── CREATE ROOM ──────────────────────────────────────
function createRoom() {
  socket.emit('create_room', {
    name: state.playerName,
    difficulty: state.difficulty,
    mode: state.mode,
  });
}

socket.on('room_created', ({ code, player }) => {
  state.roomCode = code;
  state.playerId = player.id;
  state.isHost = true;
  showScreen('screen-lobby');
});

// ── JOIN ROOM ────────────────────────────────────────
function joinRoom() {
  const code = $('room-code-input').value.trim().toUpperCase();
  if (!code || code.length !== 6) { showError('join-error', 'Enter a valid 6-character code.'); return; }
  socket.emit('join_room', { name: state.playerName, code });
}

$('room-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

socket.on('room_joined', ({ code, player }) => {
  state.roomCode = code;
  state.playerId = player.id;
  state.isHost = false;
  hideError('join-error');
  showScreen('screen-lobby');
});

socket.on('error', msg => {
  toast(msg, 'red');
  showError('join-error', msg);
  showError('create-error', msg);
});

// ── LOBBY ────────────────────────────────────────────
socket.on('lobby_update', (data) => {
  $('lobby-code').textContent = data.code;
  $('lobby-difficulty').textContent = data.difficulty.charAt(0).toUpperCase() + data.difficulty.slice(1);
  $('lobby-mode').textContent = data.mode === 'teams' ? 'Teams' : 'Individual';

  // Show teams section if teams mode
  $('teams-section').classList.toggle('hidden', data.mode !== 'teams');

  // Render players
  const list = $('players-list');
  list.innerHTML = '';
  data.players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'player-item';
    div.innerHTML = `
      <div class="player-avatar">${p.name.charAt(0).toUpperCase()}</div>
      <span class="player-name">${p.name}${p.team ? ` <small style="color:var(--text2)">(${p.team})</small>` : ''}</span>
      ${p.isHost ? '<span class="player-tag">👑 Host</span>' : ''}
      ${p.id === state.playerId && !p.isHost ? '<span class="player-tag">You</span>' : ''}
    `;
    list.appendChild(div);
  });

  // Host vs guest controls
  const amHost = data.host === socket.id;
  state.isHost = amHost;
  $('host-controls').classList.toggle('hidden', !amHost);
  $('guest-waiting').classList.toggle('hidden', amHost);

  // Enable start only if 2+ players
  const startBtn = $('start-btn');
  startBtn.disabled = data.players.length < 2;
  startBtn.textContent = data.players.length < 2
    ? `Waiting for players... (${data.players.length}/2 min)`
    : `Start Game (${data.players.length} players) 🚀`;
});

function setTeam(teamName) {
  socket.emit('set_team', { code: state.roomCode, teamName });
}

function copyCode() {
  navigator.clipboard.writeText(state.roomCode).then(() => toast('Code copied! 📋'));
}

// ── START GAME ───────────────────────────────────────
function startGame() {
  socket.emit('start_game', { code: state.roomCode });
}

socket.on('game_loading', ({ message }) => {
  $('loading-text').textContent = message;
  showScreen('screen-loading');
});

// ── ROUND START ──────────────────────────────────────
socket.on('round_start', ({ round, title, instructions, totalQuestions, timeLimit }) => {
  $('intro-round-badge').textContent = `Round ${round}`;
  $('intro-title').textContent = title;
  $('intro-instructions').textContent = instructions;

  showScreen('screen-round-intro');
  startIntroCountdown(4);
});

function startIntroCountdown(secs) {
  let n = secs;
  const fill = $('intro-countdown-fill');
  const num  = $('intro-countdown');

  if (state.introCountdown) clearInterval(state.introCountdown);
  fill.style.width = '100%';
  num.textContent = n;

  state.introCountdown = setInterval(() => {
    n--;
    num.textContent = n;
    fill.style.width = (n / secs * 100) + '%';
    if (n <= 0) clearInterval(state.introCountdown);
  }, 1000);
}

// ── QUESTION ─────────────────────────────────────────
socket.on('question', ({ round, questionIndex, total, question, options }) => {
  state.currentQuestion = { round, questionIndex, total, question, options };
  state.hasAnswered = false;

  $('q-round-label').textContent = `Round ${round}`;
  $('q-progress').textContent = `Q ${questionIndex + 1}/${total}`;
  $('question-text').textContent = question;
  $('answer-feedback').classList.add('hidden');
  $('r2-controls').classList.add('hidden');

  renderOptions(options);
  showScreen('screen-question');
});

// Round 2 question
socket.on('round2_question', ({ questionIndex, total, question, options, timeLeft }) => {
  state.currentQuestion = { round: 2, questionIndex, total, question, options };
  state.hasAnswered = false;

  $('q-round-label').textContent = 'Round 2';
  $('q-progress').textContent = `Q ${questionIndex + 1}/${total}`;
  $('question-text').textContent = question;
  $('answer-feedback').classList.add('hidden');

  renderOptions(options);
  showScreen('screen-question');

  // Show timer + skip for host
  $('r2-controls').classList.remove('hidden');
  $('skip-btn').classList.toggle('hidden', !state.isHost);

  startRound2Timer(timeLeft);
});

function renderOptions(options) {
  const grid = $('options-grid');
  grid.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.textContent = opt;
    btn.onclick = () => submitAnswer(opt);
    grid.appendChild(btn);
  });
}

function submitAnswer(answer) {
  if (state.hasAnswered) return;
  state.hasAnswered = true;

  // Highlight selected
  document.querySelectorAll('.option-btn').forEach(btn => {
    btn.disabled = true;
    if (btn.textContent === answer) btn.classList.add('selected');
  });

  socket.emit('submit_answer', {
    code: state.roomCode,
    answer,
    questionIndex: state.currentQuestion.questionIndex,
    timestamp: Date.now(),
  });
}

function skipQuestion() {
  socket.emit('round2_skip', { code: state.roomCode });
}

// ── ANSWER RESULT ────────────────────────────────────
socket.on('answer_result', ({ correct, isFirst, pointsEarned, correctAnswer, explanation, questionIndex }) => {
  // Highlight correct/wrong options
  document.querySelectorAll('.option-btn').forEach(btn => {
    if (btn.textContent === correctAnswer) btn.classList.add('correct');
    else if (btn.classList.contains('selected') && !correct) btn.classList.add('wrong');
  });

  const feedback = $('answer-feedback');
  feedback.classList.remove('hidden');

  $('feedback-icon').textContent = correct ? (isFirst ? '🥇' : '✅') : '❌';
  $('feedback-text').textContent = correct
    ? (isFirst ? 'First correct! Full points!' : 'Correct! Half points.')
    : 'Wrong answer!';
  $('feedback-points').textContent = pointsEarned > 0 ? `+${pointsEarned} pts` : '';
  $('feedback-explanation').textContent = explanation || '';
});

// ── SCORES UPDATE ────────────────────────────────────
socket.on('scores_update', (scores) => {
  const mini = $('q-scores-mini');
  mini.innerHTML = '';
  scores.slice(0, 4).forEach((p, i) => {
    const chip = document.createElement('div');
    chip.className = 'score-chip' + (i === 0 ? ' top' : '');
    chip.textContent = `${p.name.split(' ')[0]}: ${p.score}`;
    mini.appendChild(chip);
  });
});

// ── QUESTION REVEAL ──────────────────────────────────
socket.on('question_reveal', ({ correctAnswer, explanation, scores, firstCorrect }) => {
  $('reveal-correct-answer').textContent = `✅ ${correctAnswer}`;
  $('reveal-explanation').textContent = explanation || '';
  $('reveal-first').textContent = firstCorrect
    ? `🥇 ${firstCorrect.name} answered first!`
    : '';

  renderLeaderboard('reveal-leaderboard', scores);
  showScreen('screen-reveal');
});

// ── ROUND 1 END / TOPIC SELECT ────────────────────────
socket.on('round1_end', ({ scores, winner, winnerId, topics, message }) => {
  $('round1-winner-msg').textContent = message;
  renderLeaderboard('round1-scores', scores);

  const amWinner = socket.id === winnerId;
  $('topic-picker').classList.toggle('hidden', !amWinner);
  $('topic-waiting').classList.toggle('hidden', amWinner);
  $('topic-waiting-text').textContent = `Waiting for ${winner} to pick a topic...`;

  if (amWinner) {
    const grid = $('topics-grid');
    grid.innerHTML = '';
    topics.forEach(t => {
      const btn = document.createElement('button');
      btn.className = 'topic-btn';
      btn.textContent = getTopicEmoji(t) + ' ' + t;
      btn.onclick = () => selectTopic(t);
      grid.appendChild(btn);
    });
  }

  showScreen('screen-topic-select');
});

function selectTopic(topic) {
  socket.emit('select_topic', { code: state.roomCode, topic });
}

function getTopicEmoji(topic) {
  const map = {
    'Science & Technology': '🔬', 'History': '📜', 'Movies & Cinema': '🎬',
    'Video Games': '🎮', 'Sitcoms & TV Shows': '📺', 'Sports': '⚽',
    'Geography': '🌍', 'Music': '🎵', 'Literature': '📚',
    'Food & Cuisine': '🍕', 'Mythology': '⚡', 'Space & Astronomy': '🚀',
  };
  return map[topic] || '❓';
}

// ── ROUND 2 TIMER ────────────────────────────────────
function startRound2Timer(initialSecs) {
  if (state.round2Timer) clearInterval(state.round2Timer);

  let secs = initialSecs;
  updateR2Timer(secs);

  state.round2Timer = setInterval(() => {
    secs--;
    updateR2Timer(secs);
    if (secs <= 0) clearInterval(state.round2Timer);
  }, 1000);
}

function updateR2Timer(secs) {
  $('r2-timer-text').textContent = secs + 's';
  $('r2-timer-bar').style.width = (Math.max(0, secs) / 60 * 100) + '%';
  if (secs <= 10) $('r2-timer-bar').style.background = 'var(--red)';
}

// ── GAME OVER ────────────────────────────────────────
socket.on('game_over', ({ scores, teamScores, winner, winnerScore, mode }) => {
  if (state.round2Timer) clearInterval(state.round2Timer);

  $('final-winner-name').textContent = `${winner} Wins!`;
  $('final-winner-score').textContent = `${winnerScore} points`;

  if (teamScores && mode === 'teams') {
    const teamDiv = $('final-team-scores');
    teamDiv.classList.remove('hidden');
    teamDiv.innerHTML = '<h3 style="text-align:left;color:var(--text2);font-size:.9rem;margin-bottom:.5rem">TEAM SCORES</h3>';
    teamScores.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'team-row';
      row.innerHTML = `
        <span style="font-family:'Bebas Neue';font-size:1.1rem;color:var(--text2)">${i+1}</span>
        <span class="team-row-name">${t.name}</span>
        <span class="team-row-members">${t.members.join(', ')}</span>
        <span class="team-row-score">${t.score}</span>
      `;
      teamDiv.appendChild(row);
    });
  }

  renderLeaderboard('final-leaderboard', scores, true);
  showScreen('screen-final');
});

// ── PLAYER LEFT ──────────────────────────────────────
socket.on('player_left', ({ name }) => {
  if (name) toast(`${name} left the game`, 'red');
});

// ── PLAY AGAIN ───────────────────────────────────────
function playAgain() {
  showScreen('screen-menu');
}

// ── LEADERBOARD RENDERER ─────────────────────────────
function renderLeaderboard(containerId, scores, full = false) {
  const el = $(containerId);
  el.innerHTML = '';
  const rankIcons = ['🥇', '🥈', '🥉'];
  scores.slice(0, full ? 999 : 5).forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'lb-row';
    const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    row.innerHTML = `
      <span class="lb-rank ${rankClass}">${rankIcons[i] || (i + 1)}</span>
      <span class="lb-name">${p.name}${p.team ? ` <span class="lb-team-tag">${p.team}</span>` : ''}</span>
      <span class="lb-score">${p.score} pts</span>
    `;
    el.appendChild(row);
  });
}

// ── TOAST ────────────────────────────────────────────
function toast(msg, color = 'default') {
  const t = $('toast');
  t.textContent = msg;
  t.style.color = color === 'red' ? 'var(--red)' : color === 'green' ? 'var(--green)' : 'var(--text)';
  t.classList.remove('hidden');
  t.classList.add('show');
  setTimeout(() => { t.classList.remove('show'); t.classList.add('hidden'); }, 3000);
}

function showError(id, msg) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError(id) {
  const el = $(id);
  if (el) el.classList.add('hidden');
}

// ── HANDLE DISCONNECTS ───────────────────────────────
socket.on('disconnect', () => {
  toast('Connection lost. Please refresh.', 'red');
});

socket.on('connect', () => {
  // Reassign socket.id tracking
});
