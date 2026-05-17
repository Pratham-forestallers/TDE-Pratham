import os
import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
from generator import synthesize_data

# Load env variables from the Node.js project to reuse SAP credentials
load_dotenv("../tde-app/.env")

app = FastAPI(title="TDE Synthetic Data API")

SAP_URL = os.getenv("MOCK_DESTINATION_URL", "http://192.168.1.203:8000")
SAP_USER = os.getenv("MOCK_SAP_USER", "")
SAP_PASSWORD = os.getenv("MOCK_SAP_PASSWORD", "")

from typing import Optional

class SynthesisRequest(BaseModel):
    entitySet: str
    numRecords: int = 100
    sourceData: list = []
    baseOffset: Optional[int] = None
    maskPhoneNumbers: bool = True

@app.get("/")
def health_check():
    return {"status": "ok", "service": "synthetic-api"}

@app.post("/api/synthesize")
def synthesize_endpoint(req: SynthesisRequest):
    """
    Directly fetches data from the SAP system, applies the 5-phase methodology,
    and returns synthetic data.
    """
    records = []

    # Priority 1: Use the orchestrator's source data (has correct ABAP field names for the target table)
    if req.sourceData and len(req.sourceData) > 0:
        records = req.sourceData
        print(f"Using {len(records)} source records from orchestrator (correct table schema).")

    # Priority 2: Only fetch from API_SALES_ORDER_SRV as a last resort (no orchestrator data)
    # NOTE: This path returns camelCase OData field names which do NOT match VBAK ABAP field names.
    # Only use this for schema-agnostic preview/download, never for direct table INSERT.
    if not records:
        if not SAP_URL:
            raise HTTPException(status_code=500, detail="MOCK_DESTINATION_URL is not set")

        url = f"{SAP_URL.rstrip('/')}/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder?$top=500&$format=json"
        print(f"No orchestrator data provided. Fetching reference rows from: {url}")

        try:
            response = requests.get(
                url,
                auth=(SAP_USER, SAP_PASSWORD),
                headers={"Accept": "application/json"}
            )
            response.raise_for_status()
            data = response.json()
            if "d" in data and "results" in data["d"]:
                records = data["d"]["results"]
            elif "value" in data:
                records = data["value"]
            else:
                records = [data["d"]] if "d" in data else []
            print(f"Fetched {len(records)} reference records from API_SALES_ORDER_SRV.")
        except requests.exceptions.RequestException as e:
            print(f"API fetch failed: {e}")

    if not records:
        raise HTTPException(status_code=404, detail="No source data available for ML reference.")

        
    # Generate Synthetic Data
    try:
        synthetic_records, actual_base_offset = synthesize_data(
            records, req.numRecords, req.baseOffset, mask_phones=req.maskPhoneNumbers
        )
        if synthetic_records:
            print(f"Synthetic generation complete. Records: {len(synthetic_records)}, baseOffset: {actual_base_offset}")
            
        return {
            "sourceRowsFetched": len(records),
            "syntheticRowsGenerated": len(synthetic_records),
            "actualBaseOffset": actual_base_offset,
            "results": synthetic_records
        }
    except Exception as e:
        print(f"Synthesis failed: {e}")
        import traceback
        tb = traceback.format_exc()
        raise HTTPException(status_code=500, detail=f"Data synthesis failed: {str(e)}\n\nTraceback:\n{tb}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
