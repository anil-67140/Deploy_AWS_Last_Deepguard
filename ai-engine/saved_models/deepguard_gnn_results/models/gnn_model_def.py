import torch, torch.nn as nn, torch.nn.functional as F_
CHUNK = 1_500_000
class Net(nn.Module):
    def __init__(s, d_in, n_nodes, hid, L, drop=0.0):
        super().__init__()
        s.N, s.L, s.drop = n_nodes, L, drop
        s.edge_proj = nn.Linear(d_in, hid); s.flag = nn.Parameter(torch.zeros(2, hid)); s.node0 = nn.Parameter(torch.randn(hid) * 0.1)
        s.lin_e = nn.ModuleList([nn.Linear(hid, hid) for _ in range(L)])
        s.mlps  = nn.ModuleList([nn.Sequential(nn.Linear(hid, hid), nn.ReLU(), nn.Linear(hid, hid)) for _ in range(L)])
        s.norms = nn.ModuleList([nn.LayerNorm(hid) for _ in range(L)])
        s.eps   = nn.Parameter(torch.zeros(L))
        s.head  = nn.Sequential(nn.Linear(3 * hid, hid), nn.ReLU(), nn.Dropout(drop), nn.Linear(hid, 1))
    def layer(s, l, h, E, src2, dst2, deg):
        agg = torch.zeros_like(h)
        for a in range(0, src2.shape[0], CHUNK):
            b = min(a + CHUNK, src2.shape[0])
            msg = F_.relu(h[src2[a:b]] + s.lin_e[l](E[a:b])); agg = agg.index_add(0, dst2[a:b], msg)
        agg = agg / deg[:, None]
        return s.norms[l](s.mlps[l]((1 + s.eps[l]) * h + agg))
    def encode(s, X, g):
        e = F_.relu(s.edge_proj(X)); E = torch.cat([e + s.flag[0], e + s.flag[1]], 0); h = s.node0[None, :].expand(s.N, -1).contiguous()
        for l in range(s.L):
            h = h + F_.dropout(F_.relu(s.layer(l, h, E, g['src2'], g['dst2'], g['deg'])), s.drop, s.training)
        return h, e
    def score(s, h, e, g, idx):
        return s.head(torch.cat([h[g['src'][idx]], h[g['dst'][idx]], e[idx]], 1)).squeeze(-1)

def make_graph(src, dst, n_nodes, device):
    src = torch.as_tensor(src, dtype=torch.long, device=device); dst = torch.as_tensor(dst, dtype=torch.long, device=device)
    src2 = torch.cat([src, dst]); dst2 = torch.cat([dst, src]); deg = torch.bincount(dst2, minlength=n_nodes).float().clamp(min=1.0)
    return dict(src=src, dst=dst, src2=src2, dst2=dst2, deg=deg)

@torch.no_grad()
def load_and_score(weights_path, cfg, X_edges, src, dst, device='cpu'):
    # X_edges: edge-feature matrix built exactly as in the notebook; src/dst: integer node ids (see account_index.csv). Returns a risk score per edge.
    net = Net(cfg['d_in'], cfg['n_nodes'], cfg['hidden'], cfg['layers']).to(device); net.load_state_dict(torch.load(weights_path, map_location=device)); net.eval()
    g = make_graph(src, dst, cfg['n_nodes'], device); h, e = net.encode(torch.as_tensor(X_edges, dtype=torch.float32, device=device), g)
    return torch.sigmoid(net.score(h, e, g, torch.arange(len(src), device=device))).cpu().numpy()
