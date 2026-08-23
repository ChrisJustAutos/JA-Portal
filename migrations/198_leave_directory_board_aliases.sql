-- 198_leave_directory_board_aliases.sql
-- More leave_staff_directory entries (migration 197), harvested from the board's
-- own history: every distinct name the "Payroll & Leave Applications" board has
-- used, paired with the address that board itself recorded for that person, plus
-- the short forms managers type ("Matt K", "Ollie O", "Kaleb Row" — the typo is
-- deliberate, it appears twice).
--
-- Personal addresses are used where that's what the board holds and the person
-- has no work mailbox. Where they do have one, 197 already seeded the work
-- address and the board's Email Address column still wins whenever it's filled.
--
-- Some of these people have left; an unused directory row costs nothing and
-- saves a scramble if a late application comes through in their name.
insert into leave_staff_directory (match_name, match_key, email, note) values
  ('Matthew Karger',      'matthew karger',      'matthew.karger@hotmail.com', 'from the board'),
  ('Matt Karger',         'matt karger',         'matthew.karger@hotmail.com', 'board short form'),
  ('Matt K',              'matt k',              'matthew.karger@hotmail.com', 'board short form'),
  ('Oliver Olsson',       'oliver olsson',       'dodgymechanic@gmail.com',    'from the board'),
  ('Ollie O',             'ollie o',             'dodgymechanic@gmail.com',    'board short form'),
  ('Olli O',              'olli o',              'dodgymechanic@gmail.com',    'board short form'),
  ('Oliver O',            'oliver o',            'dodgymechanic@gmail.com',    'board short form'),
  ('Jye Lumley',          'jye lumley',          'jye.lumley@gmail.com',       'from the board'),
  ('Jye L',               'jye l',               'jye.lumley@gmail.com',       'board short form'),
  ('Damien McInnes',      'damien mcinnes',      'damienmcinnes@yahoo.com',    'from the board'),
  ('Damien M',            'damien m',            'damienmcinnes@yahoo.com',    'board short form'),
  ('Damo M',              'damo m',              'damienmcinnes@yahoo.com',    'board short form'),
  ('Ethan Haas',          'ethan haas',          'ethanhaas@outlook.com.au',   'from the board'),
  ('Ethan H',             'ethan h',             'ethanhaas@outlook.com.au',   'board short form'),
  ('Amanda van Heerden',  'amanda van heerden',  'amanda@justautosmechanical.com.au', 'from the board'),
  ('Amanda VH',           'amanda vh',           'amanda@justautosmechanical.com.au', 'board short form'),
  ('Amanda',              'amanda',              'amanda@justautosmechanical.com.au', 'board short form'),
  ('Robert Carlile',      'robert carlile',      'bobbiecarlile64@gmail.com',  'from the board'),
  ('Rob Carlile',         'rob carlile',         'bobbiecarlile64@gmail.com',  'board short form'),
  ('Josh Taylor',         'josh taylor',         'joshtaylor_@hotmail.com',    'from the board'),
  ('Callan O''Malley',    'callan o malley',     'callan.omalley@hotmail.com', 'from the board'),
  ('Callan OMalley',      'callan omalley',      'callan.omalley@hotmail.com', 'board short form'),
  ('Callan O',            'callan o',            'callan.omalley@hotmail.com', 'board short form'),
  ('Callan',              'callan',              'callan.omalley@hotmail.com', 'board short form'),
  ('Kaleb Row',           'kaleb row',           'kaleb@justautosmechanical.com.au', 'board typo, seen twice'),
  ('Sam P',               'sam p',               'sam@justautosmechanical.com.au',   'board short form'),
  ('Caylum F',            'caylum f',            'caylum@justautosmechanical.com.au','board short form'),
  ('Graham Douglas Roy',  'graham douglas roy',  'graham@justautosmechanical.com.au','board long form'),
  ('James W',             'james w',             'james@justautosmechanical.com.au', 'board short form')
on conflict (match_key) do nothing;

-- Deliberately absent: Matt / Matthew Ashley and Dan O appear on the board with
-- no address anywhere, and Jordie's rows are attendance notes rather than
-- applications. If an application ever comes through in one of those names it
-- lands in the unresolved list with an email to HR, which is the right outcome
-- — better than a guessed address that bounces or reaches the wrong person.
