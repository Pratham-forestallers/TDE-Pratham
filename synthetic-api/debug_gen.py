import pandas as pd
from generator import synthesize_data

# Mock 1 record
records = [{
    "MANDT": "100",
    "VBELN": "0000000002",
    "NETWR": 175.5,
    "WAERK": "USD"
}]

result = synthesize_data(records, 5)
print("Keys in result:", result[0].keys())
print("VBELN value:", result[0]["VBELN"])
print("NETWR value:", result[0]["NETWR"])
