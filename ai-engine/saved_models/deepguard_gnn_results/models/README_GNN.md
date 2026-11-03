# DeepGuard GNN module (separate from the core detector)
Best GNN variant: **GNN + behavioural features** | headline model by validation AP: **Blend (XGBoost + GNN + behavioural features)**
Files: gnn_best.pt (+ gnn_A_edge.pt, gnn_B_behav.pt) · gnn_config.json · gnn_edge_scaler.pkl · account_index.csv · gnn_model_def.py · xgboost_reference.json
App exports: gnn_account_risk.csv (risk per account) · cytoscape_top_alerts.json (Cytoscape.js elements)
Reload: `import gnn_model_def as gm; gm.load_and_score('gnn_best.pt', json.load(open('gnn_config.json')), X_edges, src, dst)`
Mode: batch / period graph (not real-time). Core models live in ai-engine/saved_models/deepguard_training_results/.
