#!/bin/sh
# Runs once, when the Postgres volume is first created (PRD §14.1).
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\getenv sw_app_password SW_APP_DB_PASSWORD
\getenv sw_data_password SW_DATA_DB_PASSWORD

CREATE ROLE sw_app LOGIN PASSWORD :'sw_app_password';
-- CREATEROLE lets `provision` create a read-only login per store. Since Postgres 16 it gives
-- no power over roles sw_data didn't create, so sw_data can't reach sw_app through it.
CREATE ROLE sw_data LOGIN CREATEROLE PASSWORD :'sw_data_password';

CREATE DATABASE sw_app OWNER sw_app;
CREATE DATABASE sw_data OWNER sw_data;

-- Databases allow CONNECT to PUBLIC by default. Owners keep access through ownership.
REVOKE ALL ON DATABASE sw_app FROM PUBLIC;
REVOKE ALL ON DATABASE sw_data FROM PUBLIC;
REVOKE ALL ON DATABASE postgres FROM PUBLIC;
REVOKE ALL ON DATABASE template1 FROM PUBLIC;
SQL
