import base64
import urllib.request
import json

d1 = """graph TD
    UI[Web User Interface] -->|Triggers Generation| NODE[Node.js Transfer Service]
    NODE <-->|1. Fetch Anchor Data| SAP[(SAP S/4HANA / Mock System)]
    NODE <-->|2. Request Synthetic Data| PY[Python ML API]
    NODE -->|3. Push Validated Data| SAP
    
    classDef ui fill:#4A90E2,stroke:#fff,stroke-width:2px,color:#fff;
    classDef node fill:#50E3C2,stroke:#fff,stroke-width:2px,color:#333;
    classDef py fill:#F5A623,stroke:#fff,stroke-width:2px,color:#fff;
    classDef sap fill:#9013FE,stroke:#fff,stroke-width:2px,color:#fff;

    class UI ui;
    class NODE node;
    class PY py;
    class SAP sap;"""

d2 = """sequenceDiagram
    participant Node as Node.js Orchestrator
    participant ML as Python ML Engine
    participant SAP as SAP System

    Node->>SAP: Fetch "Anchor" Orders (VBAK)
    SAP-->>Node: Return Real Orders
    Node->>SAP: Pre-flight Check (KNVV)
    Note over Node,SAP: Verify anchors belong to valid<br/>Sales Area (VKORG/VTWEG/SPART)
    
    Node->>ML: Send Valid Anchors for ML Synthesis
    Note over ML: Apply KDE / PCA / SMOTE<br/>Generate new NETWR, Dates, text
    ML-->>Node: Return Synthesized VBAK Headers
    
    Note over Node: 1. Restamp KUNNR (Customer) to Anchor<br/>2. Fix Chronological Dates (GUEBG <= GUEEN)<br/>3. Assign Unique ID (99xxxxxxxx)
    
    Node->>SAP: Push Synthetic VBAK Headers
    
    Node->>SAP: Fetch Anchor Child Tables (VBAP, VBPA)
    Note over Node: Clone child tables exactly to<br/>preserve Ship-To/Bill-To integrity
    Note over Node: Scale VBAP Item Net Values to<br/>match ML-generated Header Net Value
    
    Node->>SAP: Push Scaled Child Tables
    
    Node->>SAP: Fetch PRCD_ELEMENTS (Pricing)
    Note over Node: Scale Pricing Conditions<br/>(KWERT, KAWRT, KBETR)
    Node->>SAP: Push Scaled Pricing Conditions"""

try:
    s1 = json.dumps({"code": d1, "mermaid": {"theme": "default"}})
    b1 = base64.b64encode(s1.encode('utf-8')).decode('utf-8')
    req1 = urllib.request.Request('https://mermaid.ink/img/' + b1, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req1) as response, open('diag1.png', 'wb') as out_file:
        out_file.write(response.read())
        print("diag1.png downloaded")

    s2 = json.dumps({"code": d2, "mermaid": {"theme": "default"}})
    b2 = base64.b64encode(s2.encode('utf-8')).decode('utf-8')
    req2 = urllib.request.Request('https://mermaid.ink/img/' + b2, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req2) as response, open('diag2.png', 'wb') as out_file:
        out_file.write(response.read())
        print("diag2.png downloaded")
except Exception as e:
    print(f"Error: {e}")
