"""
Continuous-batching inference engine for the local backend.

Owns one llama-cpp model and a background scheduler thread that pools every in-flight
sequence into a single llama_decode per step. So N branches, whether from one n>1 request
or several concurrent "Diverse openings" requests, genuinely decode in parallel the way
the real exllamav3 backend does, rather than being served one at a time.

Sampling is done per sequence in numpy over the top candidates of a shared logits block,
which gives full control over the token stream. That control is what turns banned_strings
into real streaming suppression (resample the token that would complete a banned phrase)
instead of a hack, and it lets each branch use its own RNG seed so siblings diverge.

Logits are requested only at each sequence's current position, so there is no logits_all
buffer and memory stays modest even at a large context.
"""

from __future__ import annotations

import contextlib
import threading
from dataclasses import dataclass, field

import numpy as np

# The sampler only keeps a small nucleus, so it works on the top candidates by logit rather
# than the whole vocab. Gemma's vocab is ~262k and a per-token full sort would dominate the
# batched decode. The nucleus for any reasonable temperature sits well within this many.
_CANDIDATE_CAP = 1024


@dataclass
class SeqSpec:
    """One sequence a request wants generated."""

    prompt_tokens: list[int]
    index: int  # branch index in the client's SSE choices
    max_tokens: int
    kind: str = "gen"  # "gen" or "probe"
    k: int = 0  # probe: number of top opening tokens to return
    temperature: float = 1.0
    top_p: float = 1.0
    top_k: int = 0
    min_p: float = 0.0
    repetition_penalty: float | None = None
    min_tokens: int = 0
    stop: tuple[str, ...] = ()
    banned_strings: tuple[str, ...] = ()
    seed: int = 0


@dataclass
class _Sequence:
    spec: SeqSpec
    queue: object  # asyncio.Queue
    loop: object  # asyncio event loop
    seq_id: int = -1
    pos: int = 0
    pending: int | None = None
    generated: list[int] = field(default_factory=list)
    text: str = ""
    emitted_len: int = 0
    last_idx: int = 0
    rng: object = None
    banned_lower: tuple[str, ...] = ()
    stop_tuple: tuple[str, ...] = ()
    done: bool = False


def _top_candidates(logits_row: np.ndarray, cap: int) -> tuple[np.ndarray, np.ndarray]:
    """Return (indices, float64 logits) of the top `cap` tokens by logit for one position."""
    n = logits_row.shape[0]
    cap = min(cap, n)
    idx = np.argpartition(logits_row, n - cap)[n - cap :]
    return idx, logits_row[idx].astype(np.float64)


def _sample_candidates(
    cand_idx: np.ndarray, cand_logits: np.ndarray, seq: _Sequence, banned: set[int]
) -> int:
    """Sample one token id from a precomputed candidate set with the sequence's sampler
    settings. cand_logits is copied so the caller can resample from the same candidates."""
    spec = seq.spec
    sub = cand_logits.copy()
    cap = sub.shape[0]
    if spec.repetition_penalty and spec.repetition_penalty != 1.0 and seq.generated:
        recent = np.fromiter(set(seq.generated[-64:]), dtype=cand_idx.dtype)
        m = np.isin(cand_idx, recent)
        sub[m] = np.where(
            sub[m] > 0, sub[m] / spec.repetition_penalty, sub[m] * spec.repetition_penalty
        )
    if banned:
        sub[
            np.isin(cand_idx, np.fromiter(banned, dtype=cand_idx.dtype, count=len(banned)))
        ] = -np.inf
    temp = spec.temperature
    if temp is None or temp <= 0:
        return int(cand_idx[int(np.argmax(sub))])
    sub /= temp
    sub -= sub.max()
    probs = np.exp(sub)
    probs /= probs.sum()
    if spec.top_k and 0 < spec.top_k < cap:
        keep = np.argpartition(-probs, spec.top_k)[: spec.top_k]
        mask = np.zeros(cap, dtype=bool)
        mask[keep] = True
        probs = np.where(mask, probs, 0.0)
    if spec.min_p and spec.min_p > 0:
        probs = np.where(probs >= spec.min_p * probs.max(), probs, 0.0)
    if spec.top_p and 0 < spec.top_p < 1.0:
        order = np.argsort(-probs)
        cutoff = int(np.searchsorted(np.cumsum(probs[order]), spec.top_p)) + 1
        mask = np.zeros(cap, dtype=bool)
        mask[order[:cutoff]] = True
        probs = np.where(mask, probs, 0.0)
    total = probs.sum()
    if total <= 0:
        return int(cand_idx[int(np.argmax(sub))])
    probs /= total
    return int(cand_idx[int(seq.rng.choice(cap, p=probs))])


class Engine:
    """Loads the model and runs the scheduler thread."""

    def __init__(self, model_path: str, n_ctx: int = 8192, max_seqs: int = 16):
        self._model_path = model_path
        self._n_ctx = n_ctx
        self._max_seqs = max_seqs
        self._llm = None
        self._ctx = None
        self._batch = None
        self._batch_cap = 0
        self._n_vocab = 0
        self._terminators: set[int] = set()
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._pending: list[_Sequence] = []
        self._active: dict[int, _Sequence] = {}
        self._free_ids: list[int] = []
        self._thread: threading.Thread | None = None
        self._running = False

    # --- lifecycle -------------------------------------------------------------

    def start(self) -> None:
        self._load()
        self._free_ids = list(range(self._max_seqs))
        self._running = True
        self._thread = threading.Thread(target=self._run, name="bwbk-engine", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        with self._cond:
            self._running = False
            self._cond.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _load(self) -> None:
        from llama_cpp import Llama
        from llama_cpp import _internals as internals

        llm = Llama(model_path=self._model_path, n_ctx=self._n_ctx, n_batch=512, verbose=False)
        # The constructor builds a context with n_seq_max of 1 and registers it on
        # llm._stack. The Llama constructor raises n_seq_max only for embeddings, so free
        # that context and swap in one sized for the batch of branches we decode together.
        # Freeing it first keeps a single context alive rather than two. LlamaContext.close
        # is idempotent, so the stack closing it again at shutdown does nothing.
        llm._ctx.close()
        llm.context_params.n_seq_max = self._max_seqs
        llm._ctx = llm._stack.enter_context(
            contextlib.closing(
                internals.LlamaContext(model=llm._model, params=llm.context_params, verbose=False)
            )
        )
        self._llm = llm
        self._ctx = llm._ctx
        self._batch = llm._batch
        self._batch_cap = llm._batch._n_tokens
        self._n_vocab = llm.n_vocab()
        terminators: set[int] = set()
        eos = llm.token_eos()
        if eos is not None and eos >= 0:
            terminators.add(int(eos))
        for special in (b"<end_of_turn>", b"<eos>"):
            try:
                toks = llm.tokenize(special, add_bos=False, special=True)
            except Exception:
                continue
            if len(toks) == 1:
                terminators.add(int(toks[0]))
        self._terminators = terminators

    # --- helpers used by the endpoints ----------------------------------------

    def tokenize(self, text: str, add_bos: bool = True, special: bool = True) -> list[int]:
        return list(self._llm.tokenize(text.encode("utf-8"), add_bos=add_bos, special=special))

    @property
    def terminators(self) -> set[int]:
        return set(self._terminators)

    def submit(self, specs: list[SeqSpec], queue, loop) -> None:
        seqs = [
            _Sequence(
                spec=spec,
                queue=queue,
                loop=loop,
                rng=np.random.default_rng(spec.seed or None),
                banned_lower=tuple(b.lower() for b in spec.banned_strings if b),
                stop_tuple=tuple(s for s in spec.stop if s),
            )
            for spec in specs
        ]
        with self._cond:
            self._pending.extend(seqs)
            self._cond.notify()

    # --- scheduler -------------------------------------------------------------

    def _run(self) -> None:
        while True:
            with self._cond:
                while self._running and not self._pending and not self._active:
                    self._cond.wait()
                if not self._running:
                    return
                admitting = []
                while self._pending and len(self._active) < self._max_seqs:
                    admitting.append(self._pending.pop(0))
            for seq in admitting:
                seq.seq_id = self._free_ids.pop(0)
                self._active[seq.seq_id] = seq
                try:
                    self._admit(seq)
                except Exception as exc:  # a bad prompt should not kill the engine
                    self._emit(seq, {"kind": "error", "index": seq.spec.index, "message": str(exc)})
                    self._retire(seq)
            self._step()

    def _admit(self, seq: _Sequence) -> None:
        self._prefill(seq, seq.spec.prompt_tokens)
        logits = self._logits_at(seq.last_idx)
        if seq.spec.kind == "probe":
            self._emit_probe(seq, logits)
            self._retire(seq)
            return
        seq.pos = len(seq.spec.prompt_tokens)
        if seq.spec.max_tokens <= 0:
            self._finish(seq, "length")
            self._retire(seq)
            return
        cand_idx, cand_logits = _top_candidates(logits, _CANDIDATE_CAP)
        if not self._advance(seq, cand_idx, cand_logits):
            self._retire(seq)

    def _prefill(self, seq: _Sequence, tokens: list[int]) -> None:
        b = self._batch.batch
        n = len(tokens)
        i = 0
        while i < n:
            chunk = tokens[i : i + self._batch_cap]
            b.n_tokens = len(chunk)
            last = i + len(chunk) >= n
            for j, token in enumerate(chunk):
                b.token[j] = token
                b.pos[j] = i + j
                b.seq_id[j][0] = seq.seq_id
                b.n_seq_id[j] = 1
                b.logits[j] = 1 if (last and j == len(chunk) - 1) else 0
            if last:
                seq.last_idx = len(chunk) - 1
            self._ctx.decode(self._batch)
            i += len(chunk)

    def _step(self) -> None:
        gen = [s for s in self._active.values() if not s.done and s.pending is not None]
        if not gen:
            return
        b = self._batch.batch
        b.n_tokens = len(gen)
        for k, seq in enumerate(gen):
            b.token[k] = seq.pending
            b.pos[k] = seq.pos
            b.seq_id[k][0] = seq.seq_id
            b.n_seq_id[k] = 1
            b.logits[k] = 1
        try:
            self._ctx.decode(self._batch)
        except RuntimeError:
            # KV cache full or similar. End the active branches cleanly as length-limited.
            for seq in gen:
                self._finish(seq, "length")
                self._retire(seq)
            return
        # One logits block for the whole batch, one argpartition across all branches, so the
        # per-token vocab work happens once per step instead of once per branch.
        n = len(gen)
        vocab = self._n_vocab
        block = np.ctypeslib.as_array(self._ctx.get_logits(), shape=(n, vocab))
        cap = min(_CANDIDATE_CAP, vocab)
        part = np.argpartition(block, vocab - cap, axis=1)[:, vocab - cap :]
        for r, seq in enumerate(gen):
            seq.pos += 1
            cand_idx = part[r]
            cand_logits = block[r, cand_idx].astype(np.float64)
            if not self._advance(seq, cand_idx, cand_logits):
                self._retire(seq)

    def _advance(self, seq: _Sequence, cand_idx: np.ndarray, cand_logits: np.ndarray) -> bool:
        """Sample the next token, emit it, and return whether the sequence continues."""
        spec = seq.spec
        force_ban = set(self._terminators) if len(seq.generated) < spec.min_tokens else set()
        token = self._sample_with_bans(seq, cand_idx, cand_logits, force_ban)
        if token in self._terminators:
            self._finish(seq, "stop")
            return False
        text = self._detok(seq.generated + [token])
        stop_at = self._first_stop(text, seq.stop_tuple)
        if stop_at is not None:
            delta = text[seq.emitted_len : stop_at]
            if delta:
                self._emit(seq, {"kind": "token", "index": spec.index, "text": delta})
            self._finish(seq, "stop")
            return False
        seq.generated.append(token)
        seq.text = text
        delta = text[seq.emitted_len :]
        seq.emitted_len = len(text)
        if delta:
            self._emit(seq, {"kind": "token", "index": spec.index, "text": delta})
        if len(seq.generated) >= spec.max_tokens:
            self._finish(seq, "length")
            return False
        seq.pending = token
        return True

    def _sample_with_bans(
        self, seq: _Sequence, cand_idx: np.ndarray, cand_logits: np.ndarray, force_ban: set[int]
    ) -> int:
        """Sample, rejecting any token that would newly complete a banned string."""
        banned_tokens = set(force_ban)
        token = _sample_candidates(cand_idx, cand_logits, seq, banned_tokens)
        if not seq.banned_lower:
            return token
        prev = seq.text.lower()
        for _ in range(8):
            candidate = self._detok(seq.generated + [token]).lower()
            if any(b in candidate and b not in prev for b in seq.banned_lower):
                banned_tokens.add(token)
                token = _sample_candidates(cand_idx, cand_logits, seq, banned_tokens)
                continue
            break
        return token

    def _emit_probe(self, seq: _Sequence, logits: np.ndarray) -> None:
        lg = np.asarray(logits, dtype=np.float64).copy()
        for token in self._terminators:
            lg[token] = -np.inf
        shifted = lg - lg.max()
        logp = shifted - np.log(np.exp(shifted).sum())
        k = min(max(1, seq.spec.k), len(logp) - 1)
        top = np.argpartition(-logp, k)[:k]
        top = top[np.argsort(-logp[top])]
        top_map = {self._detok([int(t)]): float(logp[t]) for t in top}
        first = int(top[0])
        self._emit(
            seq,
            {
                "kind": "probe",
                "index": seq.spec.index,
                "top": top_map,
                "token": self._detok([first]),
                "logprob": float(logp[first]),
            },
        )

    def _finish(self, seq: _Sequence, reason: str) -> None:
        self._emit(seq, {"kind": "finish", "index": seq.spec.index, "reason": reason})

    def _retire(self, seq: _Sequence) -> None:
        if seq.seq_id in self._active:
            self._ctx.kv_cache_seq_rm(seq.seq_id, -1, -1)
            del self._active[seq.seq_id]
            self._free_ids.append(seq.seq_id)
        seq.done = True

    def _emit(self, seq: _Sequence, event: dict) -> None:
        seq.loop.call_soon_threadsafe(seq.queue.put_nowait, event)

    def _logits_at(self, i: int) -> np.ndarray:
        return np.ctypeslib.as_array(self._ctx.get_logits_ith(i), shape=(self._n_vocab,))

    def _detok(self, tokens: list[int]) -> str:
        return self._llm.detokenize(tokens).decode("utf-8", "ignore")

    @staticmethod
    def _first_stop(text: str, stops: tuple[str, ...]) -> int | None:
        found = [text.find(s) for s in stops]
        found = [i for i in found if i >= 0]
        return min(found) if found else None
