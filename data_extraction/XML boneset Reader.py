import os
import xml.etree.ElementTree as ET
import json

def extract_bones_from_xml(xml_path):
    """
    Parses the XML file and extracts bonesets and their associated bones.
    Bonesets are determined by hyperlink text with size 1200.
    Bones with size 900 are assigned to the most recent bolded boneset.
    """
    try:
        print(f"Parsing XML: {xml_path}")
        tree = ET.parse(xml_path)
        root = tree.getroot()
    except ET.ParseError as e:
        print(f"Error parsing {xml_path}: {e}")
        return {}

    # Namespace handling for XML
    ns = {
        'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
        'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
        'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    }

    bonesets = {}  # Dictionary to store bonesets
    current_boneset = None
    total_boneset = None
    bolded_set = None
    boldedList= []

    # Extract bonesets based on hyperlinks and size attributes
    for sp_element in root.findall(".//p:sp", ns):
        for r_element in sp_element.findall(".//p:txBody//a:r", ns):
            rPr_element = r_element.find("a:rPr", ns)
            text_element = r_element.find("a:t", ns)

            if rPr_element is not None and text_element is not None:
                text = text_element.text.strip()
                size = rPr_element.get("sz")
                is_bold = rPr_element.get("b") == "1"
                has_hyperlink = rPr_element.find("a:hlinkClick", ns) is not None

                if has_hyperlink:
                    if size == "1200":
                        if is_bold:
                            bolded_set = text
                        if total_boneset is None:
                            total_boneset = text
                            bonesets[total_boneset] = set()
                            continue
                        # These are their own bonesets
                        current_boneset = text
                        bonesets[current_boneset] = set()
                        bonesets[total_boneset].add(text.capitalize())
                    elif size == "900":
                        if not bolded_set:
                            boldedList.append(text.capitalize())
                        else:
                            bonesets[bolded_set].add(text.capitalize())
    for i in range(len(boldedList)):
        bonesets[bolded_set].add(boldedList[i])
                        

    return bonesets

def generate_json_output(bonesets, output_json_path):
    """
    Converts bonesets dictionary into a structured JSON format and writes it to a file.
    """
    structured_data = []

    for boneset_name, bones in bonesets.items():
        structured_data.append({
            "boneset": boneset_name,
            "bones": sorted(bones),
        })

    # Save to JSON file
    try:
        with open(output_json_path, 'w') as json_file:
            json.dump(structured_data, json_file, indent=4)
            print(f"JSON file saved: {output_json_path}")
    except IOError as e:
        print(f"Error writing to {output_json_path}: {e}")

if __name__ == "__main__":
    # Get the directory of the current script
    current_dir = os.path.dirname(os.path.abspath(__file__))

    # Define the XML and JSON file paths relative to the script's directory
    xml_file_path = os.path.join(current_dir, "slide9Pelvis.xml")
    json_file_path = os.path.join(current_dir, "output.json")

    # Extract bonesets and their bones
    bonesets = extract_bones_from_xml(xml_file_path)

    # Generate and save JSON output
    generate_json_output(bonesets, json_file_path)
