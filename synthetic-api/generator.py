import pandas as pd
import numpy as np
from scipy.stats import gaussian_kde
from sklearn.neighbors import NearestNeighbors
from sklearn.decomposition import PCA
import random

def profile_data(df: pd.DataFrame):
    """
    Phase 1: Profile data to determine numeric, text, and categorical fields.
    """
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    categorical_cols = df.select_dtypes(exclude=[np.number]).columns.tolist()
    
    # Exclude metadata and complex columns
    numeric_cols = [c for c in numeric_cols if c != '__metadata' and not c.startswith('to_')]
    categorical_cols = [c for c in categorical_cols if c != '__metadata' and not c.startswith('to_')]
    
    # Filter out columns that are unhashable
    valid_cat_cols = []
    for c in categorical_cols:
        try:
            # Try to get unique values. If it contains dicts/lists, it will throw TypeError
            _ = df[c].dropna().unique()
            valid_cat_cols.append(c)
        except TypeError:
            pass
    
    return numeric_cols, valid_cat_cols

import re
from datetime import datetime, timedelta

# SAP OData date patterns
_SAP_EPOCH_RE = re.compile(r'^/Date\((-?\d+)(\+\d+|[-]\d+)?\)/$')
_SAP_DATE_RE  = re.compile(r'^\d{8}$')           # YYYYMMDD
_SAP_TIME_RE  = re.compile(r'^PT\d{2}H\d{2}M\d{2}S$')  # PThhHmmMssS

def _detect_date_type(series: pd.Series):
    """Returns 'epoch', 'yyyymmdd', 'time', or None."""
    sample = series.dropna().astype(str)
    if sample.empty:
        return None
    if sample.map(lambda v: bool(_SAP_EPOCH_RE.match(v))).mean() > 0.7:
        return 'epoch'
    if sample.map(lambda v: bool(_SAP_TIME_RE.match(v))).mean() > 0.7:
        return 'time'
    if sample.map(lambda v: bool(_SAP_DATE_RE.match(v)) and v != '00000000').mean() > 0.7:
        return 'yyyymmdd'
    return None

def _epoch_to_dt(val: str):
    m = _SAP_EPOCH_RE.match(str(val))
    if m:
        return datetime.utcfromtimestamp(int(m.group(1)) / 1000)
    return None

def _generate_epoch_dates(series: pd.Series, n: int) -> list:
    """Generate n random /Date(...)/ values within the original date range."""
    dts = [_epoch_to_dt(v) for v in series.dropna() if _epoch_to_dt(v)]
    if not dts:
        return ['/Date(0)/'] * n
    min_ts = int(min(dts).timestamp() * 1000)
    max_ts = int(max(dts).timestamp() * 1000)
    if min_ts == max_ts:
        max_ts += 86400000  # +1 day so range is not empty
    # Use Python's random.randint (not numpy's) — numpy randint defaults to int32
    # which overflows for millisecond epoch timestamps (> 2.1B)
    return [f'/Date({random.randint(min_ts, max_ts)})/' for _ in range(n)]


def _generate_yyyymmdd_dates(series: pd.Series, n: int) -> list:
    """Generate n YYYYMMDD strings within the original date range."""
    valid = [v for v in series.dropna().astype(str) if _SAP_DATE_RE.match(v) and v != '00000000']
    if not valid:
        return ['00000000'] * n
    try:
        dts = [datetime.strptime(v, '%Y%m%d') for v in valid]
        delta = (max(dts) - min(dts)).days or 365
        return [(min(dts) + timedelta(days=int(np.random.randint(0, delta + 1)))).strftime('%Y%m%d') for _ in range(n)]
    except Exception:
        return [np.random.choice(valid) for _ in range(n)]

def _generate_time_values(series: pd.Series, n: int) -> list:
    """Generate n PThhHmmMssS values within the original time range."""
    valid = [v for v in series.dropna().astype(str) if _SAP_TIME_RE.match(v)]
    if not valid:
        return ['PT00H00M00S'] * n
    # Parse to total seconds
    def parse_sap_time(t):
        m = re.match(r'PT(\d+)H(\d+)M(\d+)S', t)
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) if m else 0
    secs = [parse_sap_time(v) for v in valid]
    min_s, max_s = min(secs), max(secs)
    if min_s == max_s:
        max_s += 3600
    result = []
    for _ in range(n):
        s = np.random.randint(min_s, max_s + 1)
        result.append(f'PT{s//3600:02d}H{(s%3600)//60:02d}M{s%60:02d}S')
    return result


def _mask_value(val: str) -> str:
    """Masks phone numbers like 999-654-2356 to 999-***-****"""
    val_str = str(val)
    # Simple regex to find digit groups
    # Preserves first group (area code usually) and masks the rest
    parts = re.split(r'(\d+)', val_str)
    digit_count = 0
    masked_parts = []
    for p in parts:
        if p.isdigit():
            digit_count += 1
            if digit_count > 1: # Mask everything after first digit group
                masked_parts.append('*' * len(p))
            else:
                masked_parts.append(p)
        else:
            masked_parts.append(p)
    return "".join(masked_parts)


def generate_unique_keys(orig_series: pd.Series, num_records: int, base_offset: int = None):
    """
    Generates unique sequential PKs in a high number range (99xxxxxxxx).
    The base is randomly chosen each call so repeated synthesis runs never
    produce the same keys — preventing duplicate-key errors on re-insertion.
    Zero-padding is preserved to match the exact SAP key format.
    """
    is_zero_padded = False
    max_len = 10
    if not orig_series.dropna().empty:
        sample = str(orig_series.dropna().iloc[0])
        max_len = max(len(str(x)) for x in orig_series.dropna())
        is_zero_padded = sample.startswith('0') and sample.isdigit()

    # Random start within 9900000000–9989999999 (leaves 10M slots above for safety)
    if base_offset is None:
        base_offset = random.randint(9900000000, 9989999999 - num_records)

    unique_keys = []
    for i in range(num_records):
        val = str(base_offset + i)
        if is_zero_padded:
            val = val.zfill(max_len)
        unique_keys.append(val)

    return unique_keys, base_offset


def apply_constraints(synth_df: pd.DataFrame, orig_df: pd.DataFrame, categorical_cols: list, base_offset: int = None, mask_phones: bool = True):
    """
    Phase 4: Enforce constraints, date/time generation, and FK categorical sampling.
    mask_phones: if True, phone/mobile fields are masked (e.g. 999-***-****).
    """
    # SAP system/infrastructure fields that must NEVER be synthesized as PKs.
    SAP_SYSTEM_FIELDS = {'MANDT', 'mandt', 'CLIENT', 'client'}
    # Fields likely containing mobile/phone numbers for masking
    PHONE_FIELDS = {'TELF1', 'TELFX', 'MOBIL', 'TELNR', 'TELEPHONE'}

    for col in categorical_cols:
        unique_vals = orig_df[col].dropna().unique()
        n = len(synth_df)

        # ── Date / Time detection (must run BEFORE PK check) ──────────────────
        date_type = _detect_date_type(orig_df[col])
        if date_type == 'epoch':
            synth_df[col] = _generate_epoch_dates(orig_df[col], n)
            continue
        if date_type == 'yyyymmdd':
            synth_df[col] = _generate_yyyymmdd_dates(orig_df[col], n)
            continue
        if date_type == 'time':
            synth_df[col] = _generate_time_values(orig_df[col], n)
            continue

        # ── Primary Key Detection ──────────────────────────────────────────────
        is_pk = False
        if col not in SAP_SYSTEM_FIELDS:
            if col in orig_df.columns and list(orig_df.columns).index(col) == 0:
                is_pk = True
            elif any(pk_hint in col.upper() for pk_hint in ['CONDITION', 'KNUMV', 'VBELN']):
                is_pk = True
            elif len(unique_vals) > 1 and len(unique_vals) == len(orig_df[col].dropna()):
                is_pk = True

        if is_pk and len(unique_vals) > 0:
            keys, actual_base = generate_unique_keys(orig_df[col], n, base_offset)
            synth_df[col] = keys
            if base_offset is None:
                base_offset = actual_base
        elif len(unique_vals) > 0:
            samples = np.random.choice(unique_vals, size=n, replace=True)
            # Mask phone fields only if masking is enabled
            if mask_phones and any(p in col.upper() for p in PHONE_FIELDS):
                synth_df[col] = [_mask_value(v) for v in samples]
            else:
                synth_df[col] = samples
        else:
            synth_df[col] = None

    return synth_df, base_offset


def generate_massive_data(df: pd.DataFrame, num_records: int, base_offset: int = None, mask_phones: bool = True):
    """
    Diversion 1: Massive Data (> 50 rows)
    Uses KDE for numeric modeling and categorical sampling.
    """
    print(f"Executing Massive Data Diversion for {len(df)} source rows")
    numeric_cols, categorical_cols = profile_data(df)
    synth_data = {}
    
    # Phase 2 & 3: KDE Modeling
    if numeric_cols:
        num_data = df[numeric_cols].dropna()
        if len(num_data) > 1:
            try:
                kde = gaussian_kde(num_data.T)
                synthetic_numeric = kde.resample(num_records).T
                for i, col in enumerate(numeric_cols):
                    min_val = num_data[col].min()
                    max_val = num_data[col].max()
                    synth_data[col] = np.clip(synthetic_numeric[:, i], min_val, max_val)
                    if pd.api.types.is_integer_dtype(df[col]):
                        synth_data[col] = np.round(synth_data[col]).astype(int)
            except Exception as e:
                print(f"KDE failed, falling back to independent sampling: {e}")
                for col in numeric_cols:
                    synth_data[col] = np.random.choice(num_data[col], size=num_records, replace=True)
        else:
            for col in numeric_cols:
                synth_data[col] = np.random.choice(df[col].dropna().values, size=num_records, replace=True)

    synth_df = pd.DataFrame(synth_data)
    if len(synth_df) == 0:
        synth_df = pd.DataFrame(index=range(num_records))
        
    synth_df, actual_base = apply_constraints(synth_df, df, categorical_cols, base_offset, mask_phones=mask_phones)
    return synth_df, actual_base

def generate_small_data(df: pd.DataFrame, num_records: int, base_offset: int = None, mask_phones: bool = True):
    """
    Diversion 2: Small Data (<= 50 rows)
    Uses SMOTE-style KNN Interpolation and PCA with Gaussian Noise.
    """
    print(f"Executing Small Data ML Diversion for {len(df)} source rows")
    numeric_cols, categorical_cols = profile_data(df)
    synth_df = pd.DataFrame(index=range(num_records))
    
    if numeric_cols:
        num_data = df[numeric_cols].dropna()
        if len(num_data) >= 2:
            try:
                pca = PCA(n_components=min(len(num_data), len(numeric_cols), 2))
                transformed = pca.fit_transform(num_data)
                synth_pca = []
                for _ in range(num_records):
                    base_idx = np.random.randint(0, len(transformed))
                    base_point = transformed[base_idx]
                    noise = np.random.normal(0, np.sqrt(pca.explained_variance_) * 0.1)
                    synth_pca.append(base_point + noise)
                reconstructed = pca.inverse_transform(synth_pca)
                for i, col in enumerate(numeric_cols):
                    synth_df[col] = np.clip(reconstructed[:, i], num_data[col].min(), num_data[col].max())
                    if pd.api.types.is_integer_dtype(df[col]):
                        synth_df[col] = np.round(synth_df[col]).astype(int)
            except Exception as e:
                print(f"PCA failed: {e}. Falling back to KNN Interpolation.")
                k = min(3, len(num_data))
                neigh = NearestNeighbors(n_neighbors=k)
                neigh.fit(num_data)
                synth_numeric = []
                num_data_array = num_data.values
                for _ in range(num_records):
                    idx = np.random.randint(0, len(num_data))
                    distances, indices = neigh.kneighbors([num_data_array[idx]])
                    neighbor_idx = np.random.choice(indices[0][1:] if len(indices[0]) > 1 else indices[0])
                    gap = np.random.random()
                    new_row = num_data_array[idx] + gap * (num_data_array[neighbor_idx] - num_data_array[idx])
                    synth_numeric.append(new_row)
                synth_numeric = np.array(synth_numeric)
                for i, col in enumerate(numeric_cols):
                    synth_df[col] = synth_numeric[:, i]
                    if pd.api.types.is_integer_dtype(df[col]):
                        synth_df[col] = np.round(synth_df[col]).astype(int)
        else:
            for col in numeric_cols:
                synth_df[col] = np.random.choice(df[col].dropna().values, size=num_records, replace=True)
                
    synth_df, actual_base = apply_constraints(synth_df, df, categorical_cols, base_offset, mask_phones=mask_phones)
    return synth_df, actual_base

def synthesize(df: pd.DataFrame, num_records: int = 100, base_offset: int = None, mask_phones: bool = True):
    """
    Main entry point for the Synthesis Engine.
    Routes to Small or Massive data diversions based on source size.
    Returns (synth_df, actual_base_offset).
    """
    if len(df) <= 50:
        return generate_small_data(df, num_records, base_offset, mask_phones=mask_phones)
    else:
        return generate_massive_data(df, num_records, base_offset, mask_phones=mask_phones)

def synthesize_data(records: list, num_records: int, base_offset: int = None, mask_phones: bool = True):
    if not records:
        return [], None
        
    df = pd.DataFrame(records)
    
    cols_to_drop = []
    for col in df.columns:
        if col.startswith('to_') or col == '__metadata':
            cols_to_drop.append(col)
        else:
            try:
                _ = df[col].dropna().unique()
            except TypeError:
                cols_to_drop.append(col)
    
    if cols_to_drop:
        df = df.drop(columns=cols_to_drop)
    
    # Force known SAP PK fields to string type BEFORE profiling.
    SAP_STRING_FIELDS = {'VBELN', 'EBELN', 'KNUMV', 'LIFNR', 'KUNNR', 'MATNR',
                         'AUFNR', 'EKGRP', 'BUKRS', 'WERKS', 'LGORT', 'BSTNK'}
    for col in df.columns:
        if col.upper() in SAP_STRING_FIELDS:
            df[col] = df[col].astype(str)
    
    synth_df, actual_base = synthesize(df, num_records, base_offset, mask_phones=mask_phones)
        
    # Phase 5: Validation
    print("Phase 5: Validating Output...")
    for col in synth_df.columns:
        if pd.api.types.is_numeric_dtype(synth_df[col]):
            synth_df[col] = synth_df[col].fillna(0)
        else:
            synth_df[col] = synth_df[col].fillna("")
    
    print(f"Actual base offset used: {actual_base}, mask_phones: {mask_phones}")
    return synth_df.to_dict(orient="records"), actual_base
