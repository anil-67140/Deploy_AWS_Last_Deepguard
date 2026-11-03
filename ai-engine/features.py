"""
DeepGuard feature engineering (47 past-only behavioural features).

build_features() and window_features() are copied from notebooks/DeepGuard_Training_Final.ipynb (Step 2)
so the serving features match training. The only change is the categorical encoding, which uses fixed
vocabularies instead of per-batch pd.factorize (see build_features).
"""
import re
import numpy as np
import pandas as pd

# Columns of the raw frame that main._to_frame() builds / the per-job context keeps
RAW_COLS = ["Timestamp", "From_Bank", "Sender", "To_Bank", "Receiver", "Amount_Received",
            "Receiving_Currency", "Amount_Paid", "Payment_Currency", "Payment_Format"]

# Label vocabularies of the IBM AML dataset the models were trained on
PAYMENT_FORMATS = ["ACH", "Bitcoin", "Cash", "Cheque", "Credit Card", "Reinvestment", "Wire"]
CURRENCIES = ["Australian Dollar", "Bitcoin", "Brazil Real", "Canadian Dollar", "Euro", "Mexican Peso",
              "Ruble", "Rupee", "Saudi Riyal", "Shekel", "Swiss Franc", "UK Pound", "US Dollar", "Yen", "Yuan"]

# sorted label -> code (same order pd.factorize(sort=True) produced in training)
FORMAT_CODE = {v: i for i, v in enumerate(sorted(PAYMENT_FORMATS))}
CURRENCY_CODE = {v: i for i, v in enumerate(sorted(CURRENCIES))}


def _key(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


# tolerant lookup: case / spacing / punctuation-insensitive, plus common aliases
_FORMAT_LOOKUP = {_key(v): v for v in PAYMENT_FORMATS}
_FORMAT_LOOKUP.update({_key(a): v for a, v in {
    "check": "Cheque", "credit": "Credit Card", "creditcard": "Credit Card", "cc": "Credit Card",
    "wiretransfer": "Wire", "btc": "Bitcoin"}.items()})

_CURRENCY_LOOKUP = {_key(v): v for v in CURRENCIES}
_CURRENCY_LOOKUP.update({_key(a): v for a, v in {
    "usd": "US Dollar", "dollar": "US Dollar", "usdollar": "US Dollar", "eur": "Euro",
    "cny": "Yuan", "rmb": "Yuan", "renminbi": "Yuan", "ils": "Shekel", "cad": "Canadian Dollar",
    "gbp": "UK Pound", "pound": "UK Pound", "rub": "Ruble", "aud": "Australian Dollar",
    "chf": "Swiss Franc", "inr": "Rupee", "jpy": "Yen", "mxn": "Mexican Peso", "brl": "Brazil Real",
    "sar": "Saudi Riyal", "btc": "Bitcoin"}.items()})


def normalize_currency(x):
    """Map any currency spelling/code to the canonical training label (unknown values are returned stripped)."""
    s = "" if x is None else str(x).strip()
    return _CURRENCY_LOOKUP.get(_key(s), s)


def normalize_format(x):
    """Map any payment-format spelling to the canonical training label (unknown values are returned stripped)."""
    s = "" if x is None else str(x).strip()
    return _FORMAT_LOOKUP.get(_key(s), s)


def build_features(df):
    '''df must be sorted by time (stable). EVERY feature uses only rows EARLIER in the sorted order (plus the row itself)
    -> no future leakage; train/val/test rows get features computed in exactly the same way.'''
    n = len(df)
    allacc = pd.concat([df['Sender'], df['Receiver']], ignore_index=True)
    codes, _ = pd.factorize(allacc)
    sid = codes[:n].astype('int64'); rid = codes[n:].astype('int64')
    t = (df['Timestamp'] - df['Timestamp'].min()).dt.total_seconds().to_numpy()
    ap = df['Amount_Paid'].to_numpy('float64'); ar = df['Amount_Received'].to_numpy('float64')

    w = pd.DataFrame({'sid': sid, 'rid': rid, 't': t, 'ap': ap, 'ar': ar})
    w['hb'] = (t // 3600).astype('int64'); w['db'] = (t // 86400).astype('int64')
    F = pd.DataFrame(index=w.index)

    # ---- basic row features ----
    F['Log_Amount_Paid']  = np.log1p(ap)
    F['Log_Amount_Recv']  = np.log1p(ar)
    F['Log_Amount_Ratio'] = F['Log_Amount_Paid'] - F['Log_Amount_Recv']
    F['Is_Round_Amount']  = ((ap % 1000) == 0).astype('int8')
    hour = df['Timestamp'].dt.hour.to_numpy()
    F['Hour'] = hour; F['DayOfWeek'] = df['Timestamp'].dt.dayofweek.to_numpy()
    F['Is_Night'] = ((hour >= 22) | (hour <= 5)).astype('int8')
    F['Is_Self_Transfer']  = (sid == rid).astype('int8')
    F['Is_Cross_Bank']     = (df['From_Bank'].to_numpy() != df['To_Bank'].to_numpy()).astype('int8')
    F['Is_Cross_Currency'] = (df['Receiving_Currency'].astype(str).to_numpy() != df['Payment_Currency'].astype(str).to_numpy()).astype('int8')
    # Fixed vocabularies (sorted) -> identical codes to the notebook's pd.factorize(sort=True) when all labels are
    # present, and stable for any batch/subset (a batch with only 5 formats must not shift the codes).
    for col, name, vocab in [('Payment_Format',      'Payment_Format_enc',      FORMAT_CODE),
                             ('Payment_Currency',    'Payment_Currency_enc',    CURRENCY_CODE),
                             ('Receiving_Currency',  'Receiving_Currency_enc',  CURRENCY_CODE)]:
        F[name] = df[col].astype(str).map(vocab).fillna(-1).astype('int8')   # -1 = label never seen in training

    # ---- sender history (strictly earlier rows) ----
    gs = w.groupby('sid')
    F['S_out_n']     = gs.cumcount()
    prev_sum         = gs['ap'].cumsum() - w['ap']
    avg_prev         = prev_sum / F['S_out_n'].where(F['S_out_n'] > 0)
    F['S_amt_vs_avg'] = F['Log_Amount_Paid'] - np.log1p(avg_prev)
    F['S_dt_prev']   = gs['t'].diff()
    pair_n           = w.groupby(['sid', 'rid']).cumcount()
    F['Pair_n']      = pair_n
    new_pair         = (pair_n == 0).astype('int64')
    F['S_uniq_recv'] = new_pair.groupby(w['sid']).cumsum() - new_pair
    F['S_new_recv_rate'] = F['S_uniq_recv'] / (F['S_out_n'] + 1)
    F['S_same_hour'] = w.groupby(['sid', 'hb']).cumcount()
    F['S_same_day']  = w.groupby(['sid', 'db']).cumcount()
    F['S_same_amt']  = w.groupby(['sid', 'ap']).cumcount()

    # ---- receiver history ----
    gr = w.groupby('rid')
    F['R_in_n']      = gr.cumcount()
    F['R_dt_prev']   = gr['t'].diff()
    F['R_uniq_send'] = new_pair.groupby(w['rid']).cumsum() - new_pair
    F['R_same_hour'] = w.groupby(['rid', 'hb']).cumcount()
    F['R_same_day']  = w.groupby(['rid', 'db']).cumcount()
    r_prev_sum       = gr['ar'].cumsum() - w['ar']
    F['R_amt_vs_avg'] = F['Log_Amount_Recv'] - np.log1p(r_prev_sum / F['R_in_n'].where(F['R_in_n'] > 0))

    # ---- in/out behaviour of each account (pass-through / mule patterns) ----
    ev_acct = np.concatenate([sid, rid]); ev_pos = np.arange(2 * n)
    ev_ord  = np.concatenate([np.arange(n), np.arange(n)])
    ev_in   = np.concatenate([np.zeros(n, 'int8'), np.ones(n, 'int8')])
    ev_amt  = np.concatenate([ap, ar])
    order   = np.lexsort((ev_in, ev_ord))
    E = pd.DataFrame({'a': ev_acct[order], 'isin': ev_in[order].astype('int64'), 'amt': ev_amt[order], 'pos': ev_pos[order]})
    E['in_amt']  = E['amt'] * E['isin']
    E['out_amt'] = E['amt'] * (1 - E['isin'])
    E['isout']   = 1 - E['isin']
    ge = E.groupby('a')
    cum_in_amt  = ge['in_amt'].cumsum()  - E['in_amt']
    cum_out_amt = ge['out_amt'].cumsum() - E['out_amt']
    cum_in_n    = ge['isin'].cumsum()    - E['isin']
    cum_out_n   = ge['isout'].cumsum()   - E['isout']
    res = np.zeros((4, 2 * n))
    res[0, E['pos'].to_numpy()] = cum_in_amt.to_numpy()
    res[1, E['pos'].to_numpy()] = cum_out_amt.to_numpy()
    res[2, E['pos'].to_numpy()] = cum_in_n.to_numpy()
    res[3, E['pos'].to_numpy()] = cum_out_n.to_numpy()
    F['S_prior_in_n']     = res[2, :n]
    F['S_prior_in_amt']   = np.log1p(res[0, :n])
    F['S_passthru']       = F['Log_Amount_Paid'] - F['S_prior_in_amt']
    selfm = (sid == rid)
    F['R_prior_out_n']    = res[3, n:] - selfm
    F['R_prior_out_amt']  = np.log1p(np.maximum(res[1, n:] - ap * selfm, 0))
    F['R_prior_in_amt']   = np.log1p(res[0, n:])
    F['R_out_in_ratio']   = F['R_prior_out_amt'] - F['R_prior_in_amt']
    return F.astype('float32')

def window_features(df):
    '''Past-only time-window activity (last 1h / 24h). Own-role windows use position order (same as cumcount);
    cross-role windows (sender's recent INCOMING, receiver's recent OUTGOING) use strictly earlier timestamps.'''
    n = len(df)
    allacc = pd.concat([df['Sender'], df['Receiver']], ignore_index=True)
    codes, _ = pd.factorize(allacc)
    sid = codes[:n].astype('int64'); rid = codes[n:].astype('int64')
    t = (df['Timestamp'] - df['Timestamp'].min()).dt.total_seconds().to_numpy().astype('int64')
    ap = df['Amount_Paid'].to_numpy('float64'); ar = df['Amount_Received'].to_numpy('float64')
    K = np.int64(max(10**8, 2 * int(t.max() if n else 0) + 2 * 86400)); out = {}   # key stride must exceed the time span (long uploads)
    def own(acct, amt, tag):
        order = np.lexsort((np.arange(n), t, acct))
        key = acct[order] * K + t[order]
        cs = np.concatenate([[0.0], np.cumsum(amt[order])]); pos = np.arange(n)
        for W, nm in [(3600, '1h'), (86400, '24h')]:
            lo = np.searchsorted(key, key - W, side='left')
            c = np.empty(n); c[order] = pos - lo; out[f'{tag}_cnt_{nm}'] = c
            if nm == '24h':
                a = np.empty(n); a[order] = cs[pos] - cs[lo]; out[f'{tag}_amt_24h'] = np.log1p(np.maximum(a, 0))
    def cross(ev_acct, ev_amt, q_acct, tag):
        order = np.lexsort((t, ev_acct))
        ek = ev_acct[order] * K + t[order]
        cs = np.concatenate([[0.0], np.cumsum(ev_amt[order])])
        qk = q_acct * K + t
        hi = np.searchsorted(ek, qk, side='left')
        for W, nm in [(3600, '1h'), (86400, '24h')]:
            lo = np.searchsorted(ek, qk - W, side='left')
            out[f'{tag}_cnt_{nm}'] = (hi - lo).astype('float64')
            if nm == '24h': out[f'{tag}_amt_24h'] = np.log1p(np.maximum(cs[hi] - cs[lo], 0))
    own(sid, ap, 'S_out'); own(rid, ar, 'R_in')
    cross(rid, ar, sid, 'S_in'); cross(sid, ap, rid, 'R_out')
    return pd.DataFrame(out).astype('float32')
