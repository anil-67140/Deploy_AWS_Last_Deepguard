import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import cytoscape from "cytoscape";
import {
  ChevronLeft,
  Loader2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Download,
  AlertTriangle,
  HelpCircle,
  X,
} from "lucide-react";
import { graphAPI } from "../utils/api";
import ExplainPanel from "../components/ExplainPanel";
import {
  buildModel,
  toElements,
  lanes as laneList,
  detectPatterns,
  neighbourhood,
  fmtAmt,
  COL_W,
  LEVEL,
  ORIGIN_COLOR,
  LOOP_COLOR,
} from "../utils/graphModel";

const CANVAS = "#0b1220";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// Visual encoding (also explained in the legend):
//   node fill/border = highest risk level it touches   node size  = money moved through it
//   line width       = money moved                      double ring = origin account
//   violet dashed + diamond = part of a round trip back to the origin
const STYLE = [
  {
    selector: "node",
    style: {
      width: "data(size)",
      height: "data(size)",
      "background-color": LEVEL.Low.fill,
      "border-color": LEVEL.Low.line,
      "border-width": 2,
      label: "data(label)",
      color: "#cbd5e1",
      "font-size": 12,
      "font-family": MONO,
      "text-valign": "bottom",
      "text-margin-y": 6,
      "text-background-color": CANVAS,
      "text-background-opacity": 0.85,
      "text-background-padding": 2,
      "text-background-shape": "roundrectangle",
      "min-zoomed-font-size": 7,
    },
  },
  ...Object.entries(LEVEL).map(([k, v]) => ({
    selector: `node[level = "${k}"]`,
    style: { "background-color": v.fill, "border-color": v.line },
  })),
  {
    selector: "node[?loop]",
    style: {
      shape: "round-diamond",
      "border-color": LOOP_COLOR,
      "border-width": 3,
    },
  },
  {
    selector: "node[?origin]",
    style: {
      shape: "ellipse",
      "border-style": "double",
      "border-width": 6,
      "border-color": ORIGIN_COLOR,
      "underlay-color": ORIGIN_COLOR,
      "underlay-opacity": 0.14,
      "underlay-padding": 10,
      "underlay-shape": "ellipse",
      "min-zoomed-font-size": 0,
    },
  },
  {
    selector: "edge",
    style: {
      width: "data(width)",
      "line-color": LEVEL.Low.line,
      "target-arrow-color": LEVEL.Low.line,
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.9,
      "curve-style": "bezier",
      opacity: 0.75,
      label: "",
      color: "#e2e8f0",
      "font-size": 10,
      "text-rotation": "autorotate",
      "text-background-color": CANVAS,
      "text-background-opacity": 0.9,
      "text-background-padding": 2,
      "text-background-shape": "roundrectangle",
    },
  },
  ...["Medium", "High", "Critical"].map((k) => ({
    selector: `edge[level = "${k}"]`,
    style: { "line-color": LEVEL[k].line, "target-arrow-color": LEVEL[k].line },
  })),
  {
    selector: "edge[?loop]",
    style: {
      "line-color": LOOP_COLOR,
      "target-arrow-color": LOOP_COLOR,
      "line-style": "dashed",
    },
  },
  {
    selector: "edge[?self]",
    style: {
      "loop-direction": "-45deg",
      "loop-sweep": "-50deg",
      "control-point-step-size": 60,
      "text-rotation": "none",
      "text-margin-y": -12,
    },
  },
  { selector: "edge.labeled", style: { label: "data(label)" } },
  { selector: ".faded", style: { opacity: 0.1, "text-opacity": 0.1 } },
  { selector: "edge.hl", style: { opacity: 1, label: "data(label)" } },
  { selector: "node.hl", style: { opacity: 1, "min-zoomed-font-size": 0 } },
  {
    selector: ".sel",
    style: {
      "overlay-color": ORIGIN_COLOR,
      "overlay-opacity": 0.22,
      "overlay-padding": 7,
    },
  },
  { selector: ".hidden", style: { display: "none" } },
];

function Segmented({ label, value, options, onChange }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex rounded-lg bg-slate-800 p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          title={o.title}
          className={`px-2.5 py-1 text-xs rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400
            ${value === o.value ? "bg-sky-500 text-white font-medium" : "text-slate-300 hover:text-white"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const IconBtn = ({ onClick, label, children }) => (
  <button
    onClick={onClick}
    aria-label={label}
    title={label}
    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
  >
    {children}
  </button>
);

function Legend({ open, setOpen }) {
  if (!open)
    return (
      <button
        onClick={() => setOpen(true)}
        className="absolute bottom-4 left-4 flex items-center gap-1.5 rounded-lg bg-slate-800/90 border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <HelpCircle className="w-3.5 h-3.5" /> How to read this
      </button>
    );
  const row = "flex items-center gap-3 text-xs text-slate-300";
  return (
    <div className="absolute bottom-4 left-4 w-64 rounded-xl bg-slate-900/95 border border-slate-700 p-3.5 space-y-2.5 shadow-xl">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-100">How to read this</p>
        <button
          onClick={() => setOpen(false)}
          aria-label="Hide legend"
          className="text-slate-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 rounded"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className={row}>
        <span className="flex gap-1 w-14 flex-shrink-0">
          {["Low", "Medium", "High", "Critical"].map((k) => (
            <span
              key={k}
              className="w-2.5 h-2.5 rounded-full"
              style={{
                background: LEVEL[k].fill,
                border: `2px solid ${LEVEL[k].line}`,
              }}
            />
          ))}
        </span>
        Colour is the highest risk an account touches
      </div>
      <div className={row}>
        <span className="w-14 flex-shrink-0 flex items-end gap-1">
          <span className="w-2.5 h-2.5 rounded-full bg-slate-600" />
          <span className="w-4 h-4 rounded-full bg-slate-600" />
        </span>
        Bigger means more money moved
      </div>
      <div className={row}>
        <span className="w-14 flex-shrink-0 flex flex-col gap-1">
          <span className="h-px bg-slate-400" />
          <span className="h-[3px] bg-slate-400" />
        </span>
        Thicker line means more money
      </div>
      <div className={row}>
        <span className="w-14 flex-shrink-0">
          <span
            className="block w-4 h-4 rounded-full"
            style={{ border: `4px double ${ORIGIN_COLOR}` }}
          />
        </span>
        Origin account of this trail
      </div>
      <div className={row}>
        <span className="w-14 flex-shrink-0 flex items-center gap-1.5">
          <span
            className="w-3 h-3 rotate-45 rounded-sm"
            style={{ border: `2px solid ${LOOP_COLOR}` }}
          />
          <span
            className="w-5 border-t-2 border-dashed"
            style={{ borderColor: LOOP_COLOR }}
          />
        </span>
        Money that can come back to the origin
      </div>
      <p className="text-xs text-slate-500 leading-relaxed pt-2 border-t border-slate-800">
        Read left to right: who sent money in, the origin, then who received it.
        Click anything to see why it matters.
      </p>
    </div>
  );
}

export default function GraphPage() {
  const { transactionId } = useParams();
  const [searchParams] = useSearchParams();
  const jobId = searchParams.get("jobId");
  const navigate = useNavigate();

  const [hops, setHops] = useState(3);
  const [direction, setDirection] = useState("both");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [selected, setSelected] = useState(null);
  const [activePattern, setActivePattern] = useState(null);
  const [showAmounts, setShowAmounts] = useState(null); // null = decide automatically from graph size
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [legendOpen, setLegendOpen] = useState(true);
  const [tip, setTip] = useState(null);

  const boxRef = useRef(null),
    cyRef = useRef(null),
    tipRef = useRef(null),
    laneRef = useRef(null);
  const modelRef = useRef(null),
    activeSet = useRef(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSelected(null);
    setActivePattern(null);
    setNotice(null);
    graphAPI
      .getTransactionGraph(transactionId, hops, jobId, direction)
      .then((res) => alive && setData(res.data))
      .catch((err) => {
        if (!alive) return;
        setNotice(
          err.response?.data?.error || "The server could not be reached.",
        );
        setData(demoGraph(transactionId, hops));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [transactionId, hops, direction, jobId]);

  const model = useMemo(() => (data ? buildModel(data) : null), [data]);
  const elements = useMemo(() => (model ? toElements(model) : []), [model]);
  const patterns = useMemo(() => (model ? detectPatterns(model) : []), [model]);
  const lanes = useMemo(() => (model ? laneList(model) : []), [model]);
  modelRef.current = model;

  // Fade everything except the given ids (null = show everything normally).
  const paint = useCallback((ids) => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass("faded hl");
      if (!ids) return;
      cy.elements().forEach((el) =>
        el.addClass(ids.has(el.id()) ? "hl" : "faded"),
      );
    });
  }, []);

  // Lane headings follow pan/zoom horizontally but stay pinned to the top, so they are always readable.
  const syncLanes = useCallback(() => {
    const cy = cyRef.current,
      box = laneRef.current;
    if (!cy || !box) return;
    const x0 = cy.pan().x,
      z = cy.zoom();
    box.childNodes.forEach((el) => {
      el.style.transform = `translateX(calc(${x0 + Number(el.dataset.col) * COL_W * z}px - 50%))`;
    });
  }, []);

  // Create the Cytoscape instance once.
  useEffect(() => {
    const cy = cytoscape({
      container: boxRef.current,
      style: STYLE,
      minZoom: 0.15,
      maxZoom: 2.5,
      wheelSensitivity: 0.25,
      boxSelectionEnabled: false,
    });
    cyRef.current = cy;
    const place = (e) => {
      if (tipRef.current && e.originalEvent) {
        tipRef.current.style.left = `${e.originalEvent.clientX + 14}px`;
        tipRef.current.style.top = `${e.originalEvent.clientY + 14}px`;
      }
    };
    cy.on("tap", "node", (e) => {
      setActivePattern(null);
      setSelected({ kind: "node", id: e.target.id() });
    });
    cy.on("tap", "edge", (e) => {
      setActivePattern(null);
      setSelected({ kind: "flow", id: e.target.id() });
    });
    cy.on("tap", (e) => {
      if (e.target === cy) {
        setSelected(null);
        setActivePattern(null);
      }
    });
    cy.on("mouseover", "node", (e) => {
      const n = e.target;
      paint(new Set(n.closedNeighborhood().map((x) => x.id())));
      const m = modelRef.current?.nodes.get(n.id());
      if (m) {
        place(e);
        setTip([
          m.id,
          `${m.level} risk, highest ${Math.round(m.maxRisk)}/100`,
          `Sent ${fmtAmt(m.sentAmt)}, received ${fmtAmt(m.recvAmt)}`,
        ]);
      }
    });
    cy.on("mouseover", "edge", (e) => {
      const ed = e.target;
      paint(new Set([ed.id(), ed.source().id(), ed.target().id()]));
      const f = modelRef.current?.flows.get(ed.id());
      if (f) {
        place(e);
        setTip([
          f.self ? "Account paying itself" : "Transfers between accounts",
          `${f.count} ${f.count === 1 ? "transaction" : "transactions"}, ${fmtAmt(f.total)} in total`,
          `Highest risk ${Math.round(f.maxRisk)}/100`,
        ]);
      }
    });
    cy.on("mouseout", "node, edge", () => {
      paint(activeSet.current);
      setTip(null);
    });
    cy.on("mousemove", "node, edge", place);
    cy.on("render", syncLanes);
    const ro = new ResizeObserver(() => cy.resize());
    ro.observe(boxRef.current);
    return () => {
      ro.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, [paint, syncLanes]);

  // New data: swap elements, keep the pre-computed lane positions, frame the result.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    setTip(null); // the element under the cursor is about to be replaced, so its mouseout will never fire
    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    cy.layout({ name: "preset" }).run();
    cy.fit(undefined, 70);
    if (cy.zoom() > 1.25) {
      cy.zoom(1.25);
      cy.center();
    }
    syncLanes();
  }, [elements, syncLanes]);

  // Selection / evidence highlighting.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !model) return;
    let set = null;
    if (activePattern) {
      const p = patterns.find((x) => x.id === activePattern);
      if (p) set = new Set([...p.nodes, ...p.flows]);
    } else if (selected) {
      const nb = neighbourhood(model, selected);
      if (nb) set = new Set([...nb.nodes, ...nb.flows]);
    }
    activeSet.current = set;
    paint(set);
    if (activePattern && set && set.size > 1) {
      const eles = cy.elements().filter((el) => set.has(el.id()));
      if (eles.length)
        cy.animate({ fit: { eles, padding: 130 }, duration: 350 });
    }
    cy.elements().removeClass("sel");
    if (selected) cy.getElementById(selected.id).addClass("sel");
  }, [model, patterns, selected, activePattern, elements, paint]);

  // On busy graphs the legend would cover nodes, so start it collapsed (once).
  const legendSeen = useRef(false);
  useEffect(() => {
    if (model && !legendSeen.current) {
      legendSeen.current = true;
      if (model.nodes.size > 12) setLegendOpen(false);
    }
  }, [model]);

  const amountsOn = showAmounts ?? (model?.flows.size || 0) <= 24;
  useEffect(() => {
    cyRef.current?.edges().toggleClass("labeled", amountsOn);
  }, [amountsOn, elements]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    setTip(null);
    cy.batch(() => {
      cy.elements().removeClass("hidden");
      if (!flaggedOnly) return;
      cy.nodes().forEach((n) => {
        if (!(n.data("origin") || n.data("flagged") || n.data("loop")))
          n.addClass("hidden");
      });
      cy.edges().forEach((e) => {
        if (
          !(e.data("flagged") || e.data("loop")) ||
          e.source().hasClass("hidden") ||
          e.target().hasClass("hidden")
        )
          e.addClass("hidden");
      });
    });
    cy.animate({
      fit: { eles: cy.elements().not(".hidden"), padding: 90 },
      duration: 300,
    });
  }, [flaggedOnly, elements]);

  const clearFinding = (id) => {
    setSelected(null);
    setActivePattern(id);
    if (!id)
      cyRef.current?.animate({
        fit: { eles: cyRef.current.elements(), padding: 70 },
        duration: 300,
      });
  };
  const zoomBy = (f) => {
    const cy = cyRef.current;
    if (cy)
      cy.zoom({
        level: cy.zoom() * f,
        renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
      });
  };
  const exportPng = () => {
    const cy = cyRef.current;
    if (!cy) return;
    const a = document.createElement("a");
    a.href = cy.png({ full: true, scale: 2, bg: CANVAS });
    a.download = `deepguard-trail-${transactionId}.png`;
    a.click();
  };

  const reach = model
    ? Math.max(0, ...[...model.nodes.values()].map((n) => Math.abs(n.col)))
    : 0;
  const trailEnds = model && data && !model.truncated && data.depth > reach;
  const flaggedCount = model ? model.txs.filter((t) => t.isFraud).length : 0;
  const dirText = {
    both: "in both directions",
    in: "back towards the senders",
    out: "forward to the receivers",
  }[direction];

  return (
    <div className="flex flex-col h-full bg-slate-900">
      <header className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <IconBtn onClick={() => navigate(-1)} label="Go back">
            <ChevronLeft className="w-4 h-4" />
          </IconBtn>
          <div className="min-w-0">
            <h1 className="font-semibold text-slate-100 text-sm">
              Money trail
            </h1>
            <p className="text-xs text-slate-400 font-mono truncate">
              {transactionId}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Segmented
            label="Direction"
            value={direction}
            onChange={setDirection}
            options={[
              {
                value: "in",
                label: "Money in",
                title: "Follow who sent money to the origin account",
              },
              {
                value: "both",
                label: "Both ways",
                title: "Follow money in and out",
              },
              {
                value: "out",
                label: "Money out",
                title: "Follow where the origin account sent money",
              },
            ]}
          />
          <div className="flex items-center gap-2">
            <span
              className="text-xs text-slate-400"
              title="How many transfers away from the origin account to follow"
            >
              Hops
            </span>
            <Segmented
              label="Hops"
              value={hops}
              onChange={setHops}
              options={[1, 2, 3, 4, 5].map((n) => ({
                value: n,
                label: String(n),
              }))}
            />
          </div>
          <button
            onClick={() => setShowAmounts(!amountsOn)}
            aria-pressed={amountsOn}
            className={`px-2.5 py-1.5 text-xs rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${amountsOn ? "bg-sky-500 text-white font-medium" : "bg-slate-800 text-slate-300 hover:text-white"}`}
          >
            Amounts
          </button>
          <button
            onClick={() => setFlaggedOnly((v) => !v)}
            aria-pressed={flaggedOnly}
            className={`px-2.5 py-1.5 text-xs rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${flaggedOnly ? "bg-sky-500 text-white font-medium" : "bg-slate-800 text-slate-300 hover:text-white"}`}
          >
            Flagged only
          </button>
          <div className="flex items-center gap-1">
            <IconBtn onClick={() => zoomBy(1.25)} label="Zoom in">
              <ZoomIn className="w-3.5 h-3.5" />
            </IconBtn>
            <IconBtn onClick={() => zoomBy(0.8)} label="Zoom out">
              <ZoomOut className="w-3.5 h-3.5" />
            </IconBtn>
            <IconBtn
              onClick={() => cyRef.current?.fit(undefined, 70)}
              label="Fit to screen"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </IconBtn>
            <IconBtn onClick={exportPng} label="Download as image">
              <Download className="w-3.5 h-3.5" />
            </IconBtn>
          </div>
        </div>
      </header>

      {model && (
        <div className="px-4 py-2 border-b border-slate-800 flex items-center gap-x-6 gap-y-1 flex-wrap text-xs text-slate-400">
          <span>
            <b className="text-slate-100 tabular-nums">{model.nodes.size}</b>{" "}
            {model.nodes.size === 1 ? "account" : "accounts"}
          </span>
          <span>
            <b className="text-slate-100 tabular-nums">{model.txs.length}</b>{" "}
            {model.txs.length === 1 ? "transaction" : "transactions"} in{" "}
            <b className="text-slate-100 tabular-nums">{model.flows.size}</b>{" "}
            {model.flows.size === 1 ? "flow" : "flows"}
          </span>
          <span>
            <b
              className="tabular-nums"
              style={{ color: flaggedCount ? LEVEL.Critical.text : "#f1f5f9" }}
            >
              {flaggedCount}
            </b>{" "}
            flagged
          </span>
          <span>
            Following up to {hops} {hops === 1 ? "transfer" : "transfers"} from
            the origin {dirText}.
            {trailEnds &&
              (reach === 0
                ? " No other accounts are connected, so changing the depth will not change this graph."
                : ` This trail ends after ${reach} ${reach === 1 ? "hop" : "hops"}, so a larger depth adds nothing.`)}
            {model.truncated &&
              ` Showing the ${model.txs.length} nearest and riskiest of ${model.totalTransactions} transactions.`}
          </span>
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-xs text-amber-200 flex items-center gap-2"
        >
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> Showing
          example data, not your results. {notice}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <div
          className="flex-1 relative min-w-0"
          style={{
            background: CANVAS,
            backgroundImage: "radial-gradient(#18233a 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        >
          <div ref={boxRef} className="absolute inset-0" />
          <div
            ref={laneRef}
            className="absolute inset-x-0 top-0 h-9 pointer-events-none overflow-hidden"
            aria-hidden="true"
          >
            {lanes.map((l) => (
              <span
                key={l.col}
                data-col={l.col}
                className="absolute top-2 left-0 whitespace-nowrap rounded-md bg-slate-900/80 px-2.5 py-1 text-xs text-slate-300"
              >
                {l.label}
              </span>
            ))}
          </div>
          {loading && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-slate-950/50"
              role="status"
            >
              <div className="text-center">
                <Loader2 className="w-8 h-8 text-sky-400 animate-spin mx-auto mb-2" />
                <p className="text-slate-300 text-sm">
                  Tracing the money trail…
                </p>
              </div>
            </div>
          )}
          <div
            ref={tipRef}
            className="fixed z-50 pointer-events-none rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 shadow-xl"
            style={{ maxWidth: 260, display: tip ? "block" : "none" }}
          >
            {tip?.map((l, i) => (
              <p
                key={i}
                className={`text-xs ${i === 0 ? "font-mono font-semibold text-slate-100" : "text-slate-300 mt-0.5"}`}
              >
                {l}
              </p>
            ))}
          </div>
          <Legend open={legendOpen} setOpen={setLegendOpen} />
        </div>

        {model && (
          <ExplainPanel
            model={model}
            focus={data.focus}
            patterns={patterns}
            selected={selected}
            onSelect={setSelected}
            onClear={() => setSelected(null)}
            activePattern={activePattern}
            onPattern={clearFinding}
          />
        )}
      </div>
    </div>
  );
}

// Example trail shown only when the API is unreachable (clearly labelled in the page).
function demoGraph(txId, hops) {
  const A = "8001A2C40",
    B = "8003B7E10",
    C = "8009D4F20";
  const t = (
    id,
    s,
    r,
    amount,
    riskScore,
    riskLevel,
    format = "Wire",
    fraudCategory = "Clean",
    min = 0,
    hop = 1,
  ) => ({
    id,
    source: s,
    target: r,
    amount,
    riskScore,
    riskLevel,
    isFraud: riskScore >= 70,
    format,
    currency: "US Dollar",
    fraudCategory,
    fromBank: "First Bank",
    toBank: "Metro Bank",
    timestamp: new Date(Date.UTC(2022, 8, 1, 10, min)).toISOString(),
    hop,
  });
  const edges = [
    t(txId, A, B, 120000, 92, "Critical", "Wire", "Circular Transaction", 0, 0),
    t("d2", B, C, 115000, 85, "Critical", "Wire", "Suspicious Layering", 12, 2),
    t(
      "d3",
      C,
      A,
      110000,
      90,
      "Critical",
      "Bitcoin",
      "Cryptocurrency Laundering",
      25,
      3,
    ),
    t("d4", A, A, 5000, 62, "Medium", "Cheque", "Unusual Transfer Volume", 31),
    t("d5", A, A, 5000, 64, "Medium", "Cheque", "Unusual Transfer Volume", 33),
    ...["D", "E", "F", "G"].map((x, i) =>
      t(
        `d${6 + i}`,
        A,
        `800${x}5C0${i}1`,
        8000 * (i + 1),
        18 + i * 4,
        "Low",
        "ACH",
        "Clean",
        40 + i,
      ),
    ),
    t("d10", "H0007F3A1", A, 30000, 22, "Low", "ACH", "Clean", 3),
  ];
  return {
    originAccount: A,
    originBank: "First Bank",
    depth: hops,
    direction: "both",
    totalTransactions: edges.length,
    truncated: false,
    edges,
    focus: {
      transactionId: txId,
      account: A,
      toAccount: B,
      amountPaid: 120000,
      paymentCurrency: "US Dollar",
      paymentFormat: "Wire",
      timestamp: edges[0].timestamp,
      riskScore: 92,
      riskLevel: "Critical",
      fraudCategory: "Circular Transaction",
      isolationForestScore: 81,
      autoencoderScore: 88,
      gnnScore: null,
      shapValues: {
        Log_Amount_Paid: 0.31,
        S_passthru: 0.18,
        Is_Round_Amount: 0.12,
        S_uniq_recv: 0.09,
        Is_Cross_Bank: 0.06,
        R_out_in_ratio: 0.05,
      },
    },
  };
}
