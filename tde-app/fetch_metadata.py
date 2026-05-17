import requests

url = "http://192.168.1.203:8000/sap/opu/odata/FDE/TDE_GEN_SRV/$metadata"
r = requests.get(
    url,
    auth=("CKP_Pratham", "P#t#150904"),
    headers={"Accept": "application/xml, text/xml, */*", "sap-client": "100"}
)
print("Status:", r.status_code)
print("Content-Type:", r.headers.get("Content-Type", ""))
print()
print(r.text[:5000])
