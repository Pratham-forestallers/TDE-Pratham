import json
from generator import synthesize_data

with open("test_payload.json", "r") as f:
    records = json.load(f)

try:
    synth = synthesize_data(records, 2)
    print("SUCCESS")
except Exception as e:
    import traceback
    traceback.print_exc()
