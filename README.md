# TDE - Test Data Engine

**Test Data Engine (TDE)** is an intelligent test data provisioning platform built for SAP. It leverages Machine Learning (via a Python/FastAPI backend) to synthetically generate large volumes of complex SAP transactional data (such as Sales Orders) based on historical document structures, and pushes them seamlessly into SAP environments.

## Features
- **Synthetic Data Generation Engine**: Employs ML distributions and KDE (Kernel Density Estimation) to generate mathematically coherent and completely anonymous Sales Order records (`VBAK`, `VBAP`, etc.) that replicate production characteristics without compromising sensitive information.
- **Dynamic Data Diversion (Cloning)**: Supports extracting full relational structures (like deeply nested SAP object trees) from a source environment and projecting them directly into target testing environments.
- **Automated Follow-On Document Synthesis**: Automatically generates dependent follow-on records (like Outbound Deliveries and Billing Invoices) corresponding to generated root objects to provide complete end-to-end transactional document flows.
- **VBFA Document Flow Integration**: Automatically writes SAP document flow (`VBFA`) links (at the header level `POSNV: 000000`) so that standard SAP screens like `VA03` recognize the connection between the newly synthesized root document and its follow-on documents.
- **Cross-Component Orchestration**: A seamless Node.js orchestration engine combined with a web UI that presents real-time extraction metrics, generation summaries, and immediately exposes all generated synthetic primary keys so users don't have to hunt them down inside the SAP GUI.

## Architecture Stack
- **Frontend**: HTML/CSS/JS with dynamic UI generation.
- **Backend Orchestrator**: Node.js/Express handling SAP OData connectivity, table relationships, follow-on configuration mapping, and data staging.
- **ML Synthesis API**: Python / FastAPI running `scipy` Gaussian KDE and independent sampling algorithms to dynamically synthesize root payload characteristics.

## Quick Start
1. **Start the ML Synthesis API**:
   ```bash
   cd synthetic-api
   venv\Scripts\python.exe main.py
   ```
2. **Start the Orchestration Engine**:
   ```bash
   cd tde-app
   npm install
   npm start
   ```
3. Access the UI at `http://localhost:3000`.
