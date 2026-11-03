# DeepGuard — training results summary

Final model (chosen on validation AP): **XGBoost + AE**  | threshold 0.4811 (best F1 on validation)

## Test-set metrics, all models
```
                        Accuracy  Balanced_Accuracy  Precision  Recall  Specificity      F1      F2  ROC_AUC  AP_PR_AUC     MCC  Cohen_Kappa   Brier  Log_Loss  Precision_at_k
Model                                                                                                                                                                         
Isolation Forest alone    0.5546             0.6522     0.0030  0.7501       0.5543  0.0059  0.0146   0.6726     0.0026  0.0257       0.0024     NaN       NaN          0.0006
Autoencoder alone         0.9849             0.5975     0.0263  0.2087       0.9863  0.0466  0.0873   0.8807     0.0164  0.0696       0.0436     NaN       NaN          0.0228
Unsupervised AE+IF        0.7789             0.7209     0.0053  0.6628       0.7791  0.0105  0.0256   0.7923     0.0041  0.0447       0.0070     NaN       NaN          0.0011
XGBoost (base)            0.9992             0.8107     0.8950  0.6216       0.9999  0.7337  0.6620   0.9921     0.7406  0.7455       0.7333  0.0007    0.0038          0.6934
XGBoost + AE              0.9992             0.8204     0.8649  0.6411       0.9998  0.7363  0.6761   0.9920     0.7436  0.7442       0.7359  0.0007    0.0039          0.6950
XGBoost + IF              0.9992             0.8185     0.8694  0.6372       0.9998  0.7354  0.6731   0.9920     0.7430  0.7439       0.7350  0.0007    0.0037          0.6978
XGBoost + AE + IF         0.9992             0.8249     0.8439  0.6500       0.9998  0.7344  0.6813   0.9919     0.7415  0.7402       0.7340  0.0007    0.0040          0.6934
```
## Confusion counts
```
                          TP      FP    FN       TN      FPR      FNR  Alerts
Model                                                                        
Isolation Forest alone  1348  451924   449   561948  0.44574  0.24986  453272
Autoencoder alone        375   13910  1422   999962  0.01372  0.79132   14285
Unsupervised AE+IF      1191  224007   606   789865  0.22094  0.33723  225198
XGBoost (base)          1117     131   680  1013741  0.00013  0.37841    1248
XGBoost + AE            1152     180   645  1013692  0.00018  0.35893    1332
XGBoost + IF            1145     172   652  1013700  0.00017  0.36283    1317
XGBoost + AE + IF       1168     216   629  1013656  0.00021  0.35003    1384
```
## Bootstrap 95% CI
```
                         AP_lo  AP_mean   AP_hi   F1_lo  F1_mean   F1_hi  ROC_AUC_lo  ROC_AUC_mean  ROC_AUC_hi
Isolation Forest alone  0.0025   0.0026  0.0026  0.0058   0.0059  0.0061      0.6646        0.6732      0.6802
Autoencoder alone       0.0152   0.0167  0.0182  0.0424   0.0473  0.0505      0.8733        0.8805      0.8892
Unsupervised AE+IF      0.0040   0.0041  0.0042  0.0101   0.0105  0.0108      0.7872        0.7930      0.7980
XGBoost (base)          0.7241   0.7413  0.7648  0.7191   0.7333  0.7541      0.9908        0.9921      0.9932
XGBoost + AE            0.7287   0.7437  0.7687  0.7172   0.7374  0.7551      0.9908        0.9921      0.9932
XGBoost + IF            0.7262   0.7431  0.7683  0.7180   0.7354  0.7574      0.9907        0.9921      0.9932
XGBoost + AE + IF       0.7250   0.7416  0.7662  0.7172   0.7343  0.7553      0.9906        0.9919      0.9931
```
## Operating points (final model)
```
      Operating point  Threshold  Precision  Recall     F1  Alerts   TP    FP  FN
    Best F1 (default)     0.4811     0.8649  0.6411 0.7363    1332 1152   180 645
High precision ≥ 0.90     0.5620     0.8942  0.6305 0.7396    1267 1133   134 664
   High recall ≥ 0.80     0.0037     0.1774  0.8687 0.2946    8800 1561  7239 236
   High recall ≥ 0.90     0.0003     0.0425  0.9293 0.0813   39289 1670 37619 127
```
Notes: fraud is 0.177% of the test period, so Accuracy is not informative — judge AP, ROC-AUC, Precision, Recall, F1, MCC.
