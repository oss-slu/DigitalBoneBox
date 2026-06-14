# DigitalBoneBox : A Web-Based Study Tool for Human Anatomy

[![Lint and Test JavaScript](https://github.com/oss-slu/DigitalBonesBox/actions/workflows/lint.yml/badge.svg)](https://github.com/oss-slu/DigitalBonesBox/actions/workflows/lint.yml)
![GitHub License](https://img.shields.io/github/license/oss-slu/DigitalBonesBox)

[![Learn About Us at OSS](https://img.shields.io/badge/Learn_About_Us_at-OSS-003AA6)](https://oss-slu.github.io/projects/digital_bone_box/about)
[![Chat on Slack](https://img.shields.io/badge/Chat_on-Slack-4A154B?logo=slack)](https://join.slack.com/t/oswslu/shared_invite/zt-24f0qhjbo-NkSfQ4LOg5wXxBdxP4vzfA)
[![Donate to OSS](https://img.shields.io/badge/Donate_to-OSS-003AA6)](https://oss-slu.github.io/connect_with/donate)

This project aims to convert an existing PowerPoint-based educational tool into an interactive, mobile-friendly web application for anatomy students.

## How / why did we get here?

This project is based on the work of Prof. Brian Elliott, created during his final years of education.
In the human anatomy class, students must purchase a bone set to study the bones of the human body,
but they are not allowed to take these models out of the lab. Prof. Elliott observed that this
restriction could cause inconvenience for students who want to quickly review the bones before an exam. To address this, he created a PowerPoint presentation that includes images of the bones taken from different angles (with permission from the department), and he annotated these images to highlight the various bones in the set using different colors and filters. He utilized all available features to create an easily accessible presentation that students could use for quick revision or brief study sessions before tests.

However, he wanted to make this resource even more accessible. He envisioned offering students a
platform they could access on their iPads, or laptops—devices commonly used by students. This is
where the web application comes in. It is designed to be a quick and easy guide for students to use
for exams, to quiz themselves on essential knowledge, or to learn from material that is simple and
provides an overview of the human bones. This application is based on the information in the
presentations created by Prof. Brian Elliott.

## Tech Stack

This project was developed using the following technologies:

* Node.js: Used for server-side development to handle requests and serve the application.
* HTML: For structuring the content of the web pages.
* HTMX: A lightweight JavaScript library for enhancing interactivity by allowing partial page updates without a full page reload.
* CSS: For styling and layout of the web pages to ensure a clean and responsive design for users across devices.

## Features

Interactive and accessible web application for students to study human anatomy.
Quick revision tool with annotated images of bones.
Designed for use on iPads, laptops, or other devices commonly used by students.

- **Toggle Sidebar**:
  - A collapsible sidebar that enhances navigation within the app.
  - Includes **placeholder options** such as **Search**, **Contact**, **Recent**, and **Help**, which are non-functional and reserved for future implementation.
  - Users can open and close the sidebar using the ☰ button on the top-left corner of the page.

## Setup

To run this project locally, you will need to have Node.js installed. The application consists of a backend API and a frontend client, which can be run together with a single command.

1. Clone the repository:

```bash
git clone https://github.com/oss-slu/DigitalBonesBox.git
cd DigitalBonesBox
```

2. Install dependencies:
This command will install the necessary packages for both the root project and the boneset-api server.

```bash
npm install
npm install --prefix boneset-api
```

3. Run the application:

To start both the backend API server and the frontend server concurrently, with the server automatically reloaded each time changes are made, run

```bash
npm run dev
```

Or, to run without live server reloading, run

```bash
npm start
```

Your browser should automatically open to the application.

## Contributing

Contributions are welcome! Check out the CONTRIBUTING.md for guidelines.
