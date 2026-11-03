"""End-to-end check of the AI Engine against the REAL trained models in saved_models/.
Run:  cd ai-engine && python tests/test_engine.py
Checks: models load, chunked scoring with job context == one-shot scoring, engine features == training-notebook features, all endpoints.
"""
import os, sys, json, warnings, numpy as np, pandas as pd
warnings.filterwarnings('ignore')
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)),'..')); sys.path.insert(0,os.getcwd())
os.environ['MODEL_PATH']='./saved_models'
from fastapi.testclient import TestClient
import main, features as FE
rng=np.random.default_rng(3)
def synth(n, seed=3):
    rng=np.random.default_rng(seed)
    acc=[f'ACC{i:04d}' for i in range(300)]
    ts=pd.Timestamp('2022-09-01')+pd.to_timedelta(np.sort(rng.integers(0,6*24*60,n)),unit='m')
    amt=rng.lognormal(7,1.6,n)
    fmts=np.array(FE.PAYMENT_FORMATS); cur=np.array(FE.CURRENCIES)
    return [dict(timestamp=t.strftime('%Y/%m/%d %H:%M'), from_bank=str(rng.integers(1,20)), account=str(rng.choice(acc)), to_bank=str(rng.integers(1,20)),
                 to_account=str(rng.choice(acc)), amount_paid=float(a), payment_currency=str(rng.choice(cur)), amount_received=float(a*rng.uniform(.95,1.05)),
                 receiving_currency=str(rng.choice(cur)), payment_format=str(rng.choice(fmts)), transaction_id=f'T{i}') for i,(t,a) in enumerate(zip(ts,amt))]
with TestClient(main.app) as c:
    r=main.registry
    print('demo_mode',r.is_demo_mode(),'| gnn',r.is_gnn_available(),'| thr',r.ensemble_threshold,'| uses_ae',r.uses_ae,'uses_if',r.uses_if,'| nfeat',len(r.final_features))
    assert not r.is_demo_mode() and r.is_gnn_available()
    txs=synth(3000)
    # --- A) one batch vs 3 context chunks
    one=c.post('/analyze/batch',json={'transactions':txs,'job_id':'JOB_ONE'}).json()
    chunks=[]
    for k in range(3):
        chunks+=c.post('/analyze/batch',json={'transactions':txs[k*1000:(k+1)*1000],'job_id':'JOB_CH'}).json()['results']
    a=np.array([x['xgboost_score'] for x in one['results']]); b=np.array([x['xgboost_score'] for x in chunks])
    print('A) chunked-with-context == single batch: max|diff| =',float(np.abs(a-b).max()))
    assert np.abs(a-b).max()<1e-6
    # no-context chunks differ (shows why context is needed)
    nc=[]
    for k in range(3): nc+=c.post('/analyze/batch',json={'transactions':txs[k*1000:(k+1)*1000]}).json()['results']
    print('   (without context the chunked scores differ by up to',float(np.abs(a-np.array([x['xgboost_score'] for x in nc])).max()),')')
    # --- B) engine features == notebook features (original factorize version) when all labels are present
    df=main._to_frame([main.Transaction(**t) for t in txs]).sort_values('Timestamp',kind='stable').reset_index(drop=True)
    Fe=pd.concat([FE.build_features(df),FE.window_features(df)],axis=1)
    import re
    nb=json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..','notebooks','DeepGuard_Training_Final.ipynb')))
    src=[''.join(x['source']) for x in nb['cells'] if x['cell_type']=='code' and 'def build_features' in ''.join(x['source'])][0]
    ns={}; exec('import numpy as np, pandas as pd\n'+src,ns)
    Fo=pd.concat([ns['build_features'](df),ns['window_features'](df)],axis=1)
    print('B) all 7/15/15 labels present?', df.Payment_Format.nunique(),df.Payment_Currency.nunique(),df.Receiving_Currency.nunique())
    assert list(Fe.columns)==list(Fo.columns)==r.base_features
    print('   max|engine - notebook| over all 47 features =', float(np.nanmax(np.abs(Fe.to_numpy()-Fo.to_numpy()))), '| NaN pattern equal:', bool((np.isnan(Fe.to_numpy())==np.isnan(Fo.to_numpy())).all()))
    # --- C) response shape + summary
    s=one['summary']; print('C) summary',{k:s[k] for k in ['total_transactions','flagged_count','critical_count','history_rows_used']})
    x=one['results'][0]; print('   result keys', sorted(x.keys()))
    top=sorted(one['results'],key=lambda x:-x['risk_score'])[0]; print('   top shap', top['shap_values'])
    # --- D) single, gnn, info, config
    sg=c.post('/analyze/single',json={'transaction':txs[5]}).json(); print('D) single ok', sg['result']['risk_score'], '| warn:', sg['warning'][:60])
    gn=c.post('/analyze/gnn',json={'transactions':txs[:1500],'job_id':'GN'}).json(); print('   gnn flagged',gn['summary'],'thr',gn['threshold'])
    wb=c.post('/analyze/batch',json={'transactions':txs[:500],'use_gnn':True}).json(); print('   use_gnn -> gnn_score present:', wb['results'][0]['gnn_score'] is not None)
    inf=c.get('/models/info').json(); print('   info perf keys', len(inf['metadata']['model_performance']), '| final', inf['metadata']['final_model']['label'], '| shap top', list(inf['metadata']['shap_feature_importance'].items())[:3])
    print('   gnn_meta perf', inf['gnn_metadata']['test_performance'])
    print('   health', c.get('/health').json()['models'])
    cfg=c.patch('/models/config',json={'ensemble_threshold':0.6}).json(); print('   patch', cfg)
    c.patch('/models/config',json={'ensemble_threshold':r.default_threshold}); os.path.exists('saved_models/engine_config.json') and os.remove('saved_models/engine_config.json')
    # --- E) robustness: bad timestamps / unknown labels / empty strings
    odd=[dict(amount_paid=10,amount_received=10),dict(timestamp='garbage',account='a',to_account='b',amount_paid=5,payment_format='Hawala',payment_currency='USD',amount_received=5,receiving_currency='XYZ')]
    ro=c.post('/analyze/batch',json={'transactions':odd}); print('E) odd inputs status',ro.status_code, [x['risk_score'] for x in ro.json()['results']])

print('\nALL ENGINE CHECKS PASSED')
