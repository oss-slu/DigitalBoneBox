import os
import xml.etree.ElementTree as ET
import json

def extract_bones_from_xml_to_json(xml_path, output_json_path):
    # Step 1: Parse the XML file
    try:
        print(f"Parsing XML: {xml_path}")
        tree = ET.parse(xml_path)
        root = tree.getroot()
    except ET.ParseError as e:
        print(f"Error parsing {xml_path}: {e}")
        return

    # Namespace handling for XML
    ns = {
        'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
        'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
        'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    }

    # Step 2: Extract bones and use a set to prevent duplicates
    unique_bones = set()

    for boneset in root.findall(".//p:sp", ns):  # Adjust this path as necessary for your XML structure
        for bone in boneset.findall(".//p:txBody//a:r/a:t", ns):
            bone_name = bone.text.strip() if bone.text else None
            if bone_name and is_valid_bone_name(bone_name):
                unique_bones.add(bone_name)

    # Step 3: Create a single boneset with all unique bones
    output_data = {
        'boneset': 'Upper Limb',  # Replace with the appropriate boneset name if needed
        'bones': sorted(unique_bones)  # Convert the set to a sorted list for consistent output
    }

    # Step 4: Write the JSON data to a file
    try:
        with open(output_json_path, 'w') as json_file:
            json.dump(output_data, json_file, indent=4)
            print(f"JSON file saved: {output_json_path}")
    except IOError as e:
        print(f"Error writing to {output_json_path}: {e}")

def is_valid_bone_name(name):
    """
    Determines if a given name is a valid bone name.
    """
    if not name:  # Ignore empty strings
        return False

    if len(name) > 50:  # Ignore overly long strings
        return False

    if "(" in name or ")" in name:  # Ignore text with parentheses
        return False

    if any(char.isdigit() for char in name):  # Ignore names with digits
        return False

    if name.islower():  # Ignore entirely lowercase words
        return False

    return True

if __name__ == "__main__":
    # Define your XML file path and output JSON file path
    xml_file_path = "/Users/tluke/OneDrive/Documents/GitHub/DigitalBoneBox/templates/slide2.xml"
    json_file_path = "/Users/tluke/OneDrive/Documents/GitHub/DigitalBoneBox/templates/output.json"

    # Run the extraction and save as JSON
    extract_bones_from_xml_to_json(xml_file_path, json_file_path)
